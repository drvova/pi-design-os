/**
 * Command implementations.
 *
 * The CLI and the MCP server both call these and nothing else, so a tool call
 * and a shell invocation cannot drift apart: same validation, same envelope,
 * same artefacts on disk. Options arrive either as CLI strings or as JSON from
 * a tool call, so every value is coerced here rather than at the two callers.
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { serveClone, servedClones, stopClones } from './clone.js';

import { cloneSite } from './crawl.js';
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

/**
 * Resolves what the caller meant by a clone.
 *
 * A path is taken as given. Anything else is read as the site it came from, so
 * `emilkowal.ski` finds the directory `clone` wrote for it without the caller
 * having to remember the naming rule.
 */
async function cloneDir(reference) {
  if (!reference) throw usage('which clone? pass a directory, or the site it was taken from');

  const candidates = [resolve(reference), resolve(`${WORKSPACE}/clone-${reference.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[^a-z0-9]+/gi, '-')}`)];
  for (const candidate of candidates) {
    const found = await stat(candidate).catch(() => null);
    if (found?.isDirectory()) return candidate;
  }

  const existing = await readdir(resolve(WORKSPACE)).catch(() => []);
  const clones = existing.filter((entry) => entry.startsWith('clone-')).map((entry) => entry.slice(6));
  throw usage(
    `no clone at ${candidates[0]}${clones.length ? `. Cloned so far: ${clones.join(', ')}` : '. Nothing cloned yet'}`,
  );
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
 * Verification re-runs the identical analysis against each cloned route served
 * over http and scores the two designs against each other. A clone nobody
 * loaded is a claim; skipping the check is possible but it is not the default.
 */
export async function clone(options = {}) {
  if (!options.url) throw usage('clone needs a url, e.g. design-os clone stripe.com');

  const wait = integer(options.wait, { name: 'wait', min: 500, max: 120000, fallback: 15000 });
  const timeout = integer(options.timeout, { name: 'timeout', min: 5000, max: 180000, fallback: 30000 });
  const budget = integer(options.budget, { name: 'budget', min: 1, max: 2048, fallback: 40 });
  const routes = integer(options.routes, { name: 'routes', min: 1, max: 200, fallback: 1 });
  const layout = choice(options.layout, { name: 'layout', allowed: ['flat', 'fsd'], fallback: 'flat' });
  const target = normaliseUrl(options.url);
  const dir = resolve(options.out ?? `${WORKSPACE}/clone-${slug(target)}`);

  progress(`Cloning ${target} into ${dir}…`);
  const site = await cloneSite({
    url: target,
    dir,
    routes,
    wait,
    timeout,
    scripts: Boolean(options.scripts),
    maxBytes: budget * 1024 * 1024,
    screenshot: Boolean(options.screenshot),
    verify: !options.skipVerify,
    layout,
  });

  const { entryReport: report, ...manifest } = site;
  progress(
    `Cloned ${site.cloned} of ${site.discovered} discovered routes, ` +
      `${site.assets.unique} unique assets, ${Math.round(site.assets.bytes / 1024)}KB`,
  );
  if (site.slices?.length) progress(`Extracted ${site.slices.length} slices across ${new Set(site.slices.map((s) => s.layer)).size} layers`);
  if (site.fidelity) progress(`Fidelity ${Math.round(site.fidelity.score * 100)}% (lowest ${Math.round(site.fidelity.lowest * 100)}%)`);

  const stem = `${WORKSPACE}/${slug(report.finalUrl)}`;
  const artefacts = { clone: dir, entry: site.entry };
  artefacts.report = await write(resolve(`${stem}.clone.json`), JSON.stringify({ ...report, site: manifest }, null, 2));
  if (options.screenshot && report.screenshot) {
    artefacts.screenshot = await write(resolve(`${stem}.png`), Buffer.from(report.screenshot, 'base64'));
  }
  if (options.open) openInBrowser(site.entry);

  return ok('clone', {
    ...bounded(report, artefacts.report),
    site: manifest,
    fidelity: site.fidelity,
    artefacts,
  });
}

/**
 * Serves a clone over http and hands back the url.
 *
 * A clone is a static tree, and `file://` refuses webfonts, so looking at one
 * means serving it. The server is registered rather than spawned and forgotten:
 * calling this twice for the same directory returns the same url, `stop` closes
 * it, and a host closes every one on shutdown.
 */
export async function serve(options = {}) {
  if (options.stop) {
    const dir = options.dir ? await cloneDir(options.dir).catch(() => null) : null;
    const stopped = await stopClones(dir ?? undefined);
    return ok('serve', { stopped, serving: servedClones() });
  }

  const dir = await cloneDir(options.dir);
  const { url, reused } = await serveClone(dir);
  progress(`${reused ? 'Already serving' : 'Serving'} ${dir} at ${url}`);
  if (options.open) openInBrowser(url);

  return ok('serve', { dir, url, reused, serving: servedClones() });
}

/**
 * Reads the slices a clone extracted.
 *
 * Without a name it lists them; with one it returns that component's markup and
 * the stylesheet holding only the rules that matched it. Both are on disk, and
 * having to reach for a shell to read them is what stops the clone being usable
 * from a tool call.
 */
export async function slices(options = {}) {
  const dir = await cloneDir(options.dir);
  const manifestPath = join(dir, 'manifest.json');
  const raw = await readFile(manifestPath, 'utf8').catch(() => null);
  if (!raw) {
    throw usage(`${dir} has no manifest.json; slices are only extracted with layout "fsd"`);
  }
  const manifest = JSON.parse(raw);

  if (!options.name) {
    const layers = {};
    for (const entry of manifest.slices) layers[entry.layer] = (layers[entry.layer] ?? 0) + 1;
    return ok('slices', {
      dir,
      source: manifest.source,
      layers,
      routes: manifest.routes,
      slices: manifest.slices.map(({ dir: at, layer, name, namedBy, tag, instances, rules, sourceFile, routes }) => ({
        dir: at,
        layer,
        name,
        namedBy,
        tag,
        instances,
        rules,
        sourceFile,
        routes: routes.length,
      })),
    });
  }

  const wanted = String(options.name);
  const found =
    manifest.slices.find((entry) => entry.dir === wanted) ??
    manifest.slices.find((entry) => entry.name === wanted) ??
    manifest.slices.find((entry) => entry.dir.endsWith(`/${wanted}`));

  if (!found) {
    throw usage(`no slice "${wanted}" in ${dir}. Call without a name to list them`);
  }

  const [markup, styles] = await Promise.all([
    readFile(join(dir, found.dir, 'ui', 'ui.html'), 'utf8'),
    readFile(join(dir, found.dir, 'ui', 'styles.css'), 'utf8'),
  ]);

  return ok('slices', {
    dir,
    slice: found,
    preview: join(dir, found.dir, 'ui', 'preview.html'),
    markup,
    styles,
  });
}

/** Every command the CLI and the MCP server expose. */
export const COMMANDS = { directions, inspect, clone, serve, slices };
