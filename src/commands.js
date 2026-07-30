/**
 * Command implementations.
 *
 * The CLI and the MCP server both call these and nothing else, so a tool call
 * and a shell invocation cannot drift apart: same validation, same envelope,
 * same artefacts on disk. Options arrive either as CLI strings or as JSON from
 * a tool call, so every value is coerced here rather than at the two callers.
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { compareDesign, serveDirectory } from './clone.js';
import { generate } from './directions.js';
import { ok, progress, usage } from './envelope.js';
import { render } from './gallery.js';
import { inspectPage, normaliseUrl } from './inspect.js';

const WORKSPACE = '.design-os';

/** Asset rows are repetitive; the complete list always lands on disk regardless. */
const MAX_INLINE_ASSETS = 150;

/** Opens a path with the platform's default handler. */
function openInBrowser(target) {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(command, [target], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' }).unref();
}

async function write(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  return path;
}

function integer(raw, { name, min, max, fallback }) {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw usage(`--${name} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}

function choice(raw, { name, allowed, fallback }) {
  if (raw === undefined || raw === '') return fallback;
  const value = String(raw).toLowerCase();
  if (!allowed.includes(value)) {
    throw usage(`--${name} must be one of ${allowed.join(', ')}, got "${raw}"`);
  }
  return value;
}

/** Filesystem-safe stem for a url. */
function slug(url) {
  return new URL(url).hostname.replace(/^www\./, '').replace(/[^a-z0-9]+/gi, '-');
}

/** Trims the one field that grows without bound; its totals sit beside it. */
function bounded(report, reportPath) {
  const { screenshot: _binary, ...payload } = report;
  return {
    ...payload,
    assets: {
      ...payload.assets,
      order: payload.assets.order.slice(0, MAX_INLINE_ASSETS),
      orderShown: Math.min(payload.assets.order.length, MAX_INLINE_ASSETS),
      orderComplete: reportPath,
    },
  };
}

/** Generates design directions and writes the gallery. */
export async function directions(options = {}) {
  const count = integer(options.count, { name: 'count', min: 1, max: 64, fallback: 12 });
  const polarity = choice(options.polarity, {
    name: 'polarity',
    allowed: ['light', 'dark', 'both'],
    fallback: 'both',
  });
  const seed = options.seed ?? Math.random().toString(36).slice(2, 10);
  const out = resolve(options.out ?? `${WORKSPACE}/directions.html`);

  progress(`Generating ${count} directions from seed "${seed}"…`);
  const generated = generate({ count, seed, polarity });
  await write(out, render(generated, { seed, title: `${count} directions` }));
  progress(`Wrote ${out}`);

  if (options.open) {
    openInBrowser(out);
    progress('Opened in browser.');
  }

  return ok('directions', {
    count,
    seed,
    polarity,
    path: out,
    directions: generated.map(({ id, label, body, axes }) => ({ id, label, body, axes })),
  });
}

/**
 * Loads a url once and reports its rendering pipeline and its design.
 *
 * The complete report is always written to disk; the returned envelope trims
 * only the per-asset list, which is the one field that grows without bound and
 * whose totals are already summarised beside it.
 */
export async function inspect(options = {}) {
  if (!options.url) throw usage('inspect needs a url, e.g. design-os inspect stripe.com');

  const wait = integer(options.wait, { name: 'wait', min: 500, max: 120000, fallback: 15000 });
  const timeout = integer(options.timeout, { name: 'timeout', min: 5000, max: 180000, fallback: 30000 });
  const screenshot = Boolean(options.screenshot);

  progress(`Loading ${options.url}…`);
  const report = await inspectPage({ url: options.url, wait, timeout, screenshot });
  const stem = `${WORKSPACE}/${slug(report.finalUrl)}`;

  const artefacts = { report: await write(resolve(`${stem}.json`), JSON.stringify(report, null, 2)) };
  progress(`Wrote ${artefacts.report}`);

  if (screenshot && report.screenshot) {
    artefacts.screenshot = await write(resolve(`${stem}.png`), Buffer.from(report.screenshot, 'base64'));
    progress(`Wrote ${artefacts.screenshot}`);
  }

  if (options.gallery) {
    const html = render([report.direction], { seed: report.finalUrl, title: `Direction from ${report.title}` });
    artefacts.gallery = await write(resolve(`${stem}.html`), html);
    progress(`Wrote ${artefacts.gallery}`);
    if (options.open) openInBrowser(artefacts.gallery);
  }

  return ok('inspect', { ...bounded(report, artefacts.report), artefacts });
}

/**
 * Writes a runnable local copy of a url and checks that it holds up.
 *
 * Verification re-runs the identical analysis against the clone served over
 * http and scores the two designs against each other. A clone nobody loaded is
 * a claim; skipping the check is possible but it is not the default.
 */
export async function clone(options = {}) {
  if (!options.url) throw usage('clone needs a url, e.g. design-os clone stripe.com');

  const wait = integer(options.wait, { name: 'wait', min: 500, max: 120000, fallback: 15000 });
  const timeout = integer(options.timeout, { name: 'timeout', min: 5000, max: 180000, fallback: 30000 });
  const budget = integer(options.budget, { name: 'budget', min: 1, max: 2048, fallback: 40 });
  const target = normaliseUrl(options.url);
  const dir = resolve(options.out ?? `${WORKSPACE}/clone-${slug(target)}`);

  progress(`Cloning ${target} into ${dir}…`);
  const report = await inspectPage({
    url: target,
    wait,
    timeout,
    screenshot: Boolean(options.screenshot),
    clone: { dir, scripts: Boolean(options.scripts), maxBytes: budget * 1024 * 1024 },
  });
  progress(`Wrote ${report.clone.files} files, ${Math.round(report.clone.bytes / 1024)}KB`);

  let fidelity = null;
  if (!options.skipVerify) {
    const server = await serveDirectory(dir);
    progress(`Verifying the clone at ${server.url}…`);
    try {
      const replica = await inspectPage({ url: server.url, wait: Math.min(wait, 8000), timeout });
      fidelity = { ...compareDesign(report, replica), capture: replica.capture };
      progress(`Fidelity ${Math.round(fidelity.score * 100)}%`);
    } finally {
      await server.close();
    }
  }

  const stem = `${WORKSPACE}/${slug(report.finalUrl)}`;
  const artefacts = { clone: dir, entry: report.clone.entry };
  artefacts.report = await write(resolve(`${stem}.clone.json`), JSON.stringify({ ...report, fidelity }, null, 2));
  if (options.screenshot && report.screenshot) {
    artefacts.screenshot = await write(resolve(`${stem}.png`), Buffer.from(report.screenshot, 'base64'));
  }
  if (options.open) openInBrowser(report.clone.entry);

  return ok('clone', { ...bounded(report, artefacts.report), fidelity, artefacts });
}

/** Every command the CLI and the MCP server expose. */
export const COMMANDS = { directions, inspect, clone };
