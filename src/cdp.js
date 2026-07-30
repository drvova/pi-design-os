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

import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

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

const run = promisify(execFile);

/** Profiles this package creates, and nothing else. */
const PROFILE_PREFIX = 'design-os-chrome-';

/**
 * The pid of whoever launched a browser, written into its own profile.
 *
 * Deciding abandonment from process parentage does not work: a child of a killed
 * process is reparented to whatever subreaper the session has, which is not
 * necessarily init, so a test for `ppid <= 1` finds nothing on a normal desktop.
 * Recording the launcher is exact and needs no assumption about the platform —
 * if that pid is gone, whatever is still holding the profile has nobody left to
 * talk to.
 */
export const LAUNCHER_FILE = '.design-os-launcher';

const alive = (pid) => {
  try {
    // Signal 0 tests for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

/** Pids whose command line mentions a path. Empty when nothing holds it. */
async function holders(path) {
  const { stdout } = await run('pgrep', ['-f', path]).catch(() => ({ stdout: '' }));
  return stdout
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

/**
 * Clears browsers and profiles left behind by a launcher that was killed.
 *
 * A session closed normally takes its browser and profile with it. A launcher
 * killed outright does not: the browser it started is reparented and keeps
 * running, holding a profile directory and burning CPU with nobody left to talk
 * to it. That happened in the field — a stack of timed-out calls, then a kill,
 * then a browser nobody owned.
 *
 * Only this package's own profiles are considered, and a profile still held by a
 * living process whose parent is alive is left strictly alone: another design-os
 * in another terminal is not an orphan.
 */
export async function reapOrphans() {
  const reaped = { browsers: 0, profiles: 0, skipped: 0 };
  const entries = await readdir(tmpdir()).catch(() => []);

  for (const name of entries) {
    if (!name.startsWith(PROFILE_PREFIX)) continue;
    const profile = join(tmpdir(), name);

    const launcher = Number(await readFile(join(profile, LAUNCHER_FILE), 'utf8').catch(() => ''));

    // A profile whose launcher is still running belongs to a live design-os,
    // possibly in another terminal, and is none of this one's business.
    if (Number.isInteger(launcher) && launcher > 0 && alive(launcher)) {
      reaped.skipped += 1;
      continue;
    }

    for (const pid of await holders(profile)) {
      try {
        process.kill(pid, 'SIGKILL');
        reaped.browsers += 1;
      } catch {
        // Already gone between listing and killing, which is the good case.
      }
    }

    // Only remove a profile once nothing is holding it.
    await new Promise((settled) => setTimeout(settled, 150));
    if ((await holders(profile)).length > 0) {
      reaped.skipped += 1;
      continue;
    }

    // A profile with no launcher recorded predates this and is only removed once
    // it is plainly not in use, so a running older version is not disturbed.
    if (!Number.isInteger(launcher) || launcher <= 0) {
      const age = await stat(profile).then((info) => Date.now() - info.mtimeMs).catch(() => 0);
      if (age < 60_000) continue;
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    reaped.profiles += 1;
  }

  return reaped;
}

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
  // Before adding another browser, clear any that a killed launcher left behind.
  const reaped = await reapOrphans();
  if (reaped.browsers > 0 || reaped.profiles > 0) {
    progress(`design-os: cleared ${reaped.browsers} orphaned browser(s) and ${reaped.profiles} profile(s)`);
  }

  const profile = await mkdtemp(join(tmpdir(), PROFILE_PREFIX));
  // Written before the browser starts, so an abandoned profile is identifiable
  // even if the launch itself is what goes wrong.
  await writeFile(join(profile, LAUNCHER_FILE), String(process.pid), 'utf8');
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
