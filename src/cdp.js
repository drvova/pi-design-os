/**
 * Chrome DevTools Protocol client.
 *
 * Node 22 ships a global WebSocket, so driving a real browser costs no
 * dependency at all. Chrome is launched against an ephemeral debugging port,
 * the endpoint is read off stderr, and the page target is resolved through the
 * HTTP discovery endpoint. Attaching to the page socket rather than the browser
 * socket removes session multiplexing entirely: every message on this socket
 * already belongs to the page under inspection.
 *
 * The page is opened on `about:blank` so instrumentation can be installed
 * before the first navigation. A probe added after navigation has already
 * missed the phase it exists to measure.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CommandError, progress } from './envelope.js';

/**
 * Every session that has not been closed yet.
 *
 * `inspectPage` closes in a `finally`, which covers a throw but not a host that
 * stops the process mid-run. A Pi session ending during a crawl would otherwise
 * leave Chrome running and a profile directory behind, so a host can close them
 * all through `closeAllSessions`.
 */
const live = new Set();

/** Closes every open session. Returns how many were still running. */
export async function closeAllSessions() {
  const open = [...live];
  await Promise.all(open.map((session) => session.close()));
  return open.length;
}

/** Searched in order; `CHROME_PATH` wins when set. */
const CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

/**
 * Port 0 lets the OS pick, which is what makes concurrent inspections safe.
 * The throttling flags are load-bearing: a headless page is never foregrounded,
 * and background throttling would distort every timestamp this module reports.
 */
const LAUNCH_FLAGS = [
  '--remote-debugging-port=0',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--hide-scrollbars',
  '--mute-audio',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-features=Translate,MediaRouter',
];

/** First Chrome or Chromium binary present on this machine. */
export function chromePath() {
  const found = CANDIDATES.find((candidate) => candidate && existsSync(candidate));
  if (!found) {
    throw new CommandError(
      'SERVER_UNAVAILABLE',
      'no Chrome or Chromium binary found. Install Chrome or set CHROME_PATH.',
    );
  }
  return found;
}

/** Resolves once Chrome prints its DevTools endpoint, rejects if it dies first. */
function readEndpoint(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffered = '';

    const timer = setTimeout(() => {
      cleanup();
      reject(
        new CommandError(
          'SERVER_UNAVAILABLE',
          `Chrome did not report a DevTools endpoint within ${timeoutMs}ms. Output: ${buffered.trim() || '(none)'}`,
        ),
      );
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
    }

    function onData(chunk) {
      buffered += chunk;
      const match = buffered.match(/ws:\/\/\S+/);
      if (!match) return;
      cleanup();
      resolve(match[0]);
    }

    function onExit(code) {
      cleanup();
      reject(
        new CommandError('SERVER_UNAVAILABLE', `Chrome exited with code ${code} before starting. Output: ${buffered.trim()}`),
      );
    }

    child.stderr.on('data', onData);
    child.on('exit', onExit);
  });
}

/** A live CDP connection to one page target. */
class Session {
  #socket;
  #timeout;
  #nextId = 0;
  #pending = new Map();
  #listeners = new Map();
  #closers = [];
  #closed = false;

  constructor(socket, timeout, closers) {
    this.#socket = socket;
    this.#timeout = timeout;
    this.#closers = closers;
    live.add(this);
    socket.addEventListener('message', (event) => this.#receive(event.data));
    socket.addEventListener('close', () => this.#rejectPending('CDP socket closed'));
    socket.addEventListener('error', () => this.#rejectPending('CDP socket errored'));
  }

  #receive(raw) {
    const message = JSON.parse(raw);

    if (message.id === undefined) {
      for (const handler of this.#listeners.get(message.method) ?? []) handler(message.params);
      return;
    }

    const entry = this.#pending.get(message.id);
    if (!entry) return;
    this.#pending.delete(message.id);
    clearTimeout(entry.timer);

    if (message.error) {
      entry.reject(new CommandError('OPERATION_FAILED', `${entry.method}: ${message.error.message}`));
      return;
    }
    entry.resolve(message.result);
  }

  #rejectPending(reason) {
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(new CommandError('OPERATION_FAILED', `${entry.method}: ${reason}`));
    }
    this.#pending.clear();
  }

  /** Issues a CDP command and resolves with its result. */
  send(method, params = {}) {
    if (this.#closed) throw new CommandError('OPERATION_FAILED', `${method}: session already closed`);
    const id = (this.#nextId += 1);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CommandError('OPERATION_FAILED', `${method}: timed out after ${this.#timeout}ms`));
      }, this.#timeout);

      this.#pending.set(id, { resolve, reject, timer, method });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Subscribes to a CDP event. Handlers run in registration order. */
  on(method, handler) {
    const handlers = this.#listeners.get(method);
    if (handlers) handlers.push(handler);
    else this.#listeners.set(method, [handler]);
  }

  /**
   * Closes the socket, kills Chrome, and removes the throwaway profile.
   *
   * Callers run this from `finally`, so a throw here would replace whatever real
   * failure sent them there. A cleanup problem is reported on stderr instead:
   * still visible, never mistaken for the cause.
   */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    live.delete(this);
    this.#rejectPending('session closing');
    this.#socket.close();

    for (const closer of this.#closers) {
      await closer().catch((error) => progress(`design-os: browser cleanup failed: ${error.message}`));
    }
  }
}

/**
 * Launches Chrome and attaches to its page target, sitting on `about:blank`.
 *
 * @param {{headless?:boolean, timeout?:number}} options
 * @returns {Promise<Session>}
 */
export async function openPage({ headless = true, timeout = 30000 } = {}) {
  const profile = await mkdtemp(join(tmpdir(), 'design-os-chrome-'));
  const flags = [...LAUNCH_FLAGS, `--user-data-dir=${profile}`];
  if (headless) flags.push('--headless=new');

  const child = spawn(chromePath(), [...flags, 'about:blank'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  // Chrome keeps writing to its profile until it is actually gone, so removing
  // the directory the instant after kill() races the process and fails with
  // ENOTEMPTY. Wait for the exit, then remove.
  const discard = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  };

  const endpoint = await readEndpoint(child, timeout).catch(async (error) => {
    await discard();
    throw error;
  });

  const { port } = new URL(endpoint);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((target) => target.type === 'page');

  if (!page) {
    await discard();
    throw new CommandError('SERVER_UNAVAILABLE', 'Chrome started but exposed no page target.');
  }

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new CommandError('SERVER_UNAVAILABLE', 'could not open the CDP socket.')), { once: true });
  }).catch(async (error) => {
    await discard();
    throw error;
  });

  return new Session(socket, timeout, [discard]);
}
