/**
 * Local clone of an inspected page.
 *
 * The clone is taken from the same navigation as the analysis. Loading the page
 * a second time to fetch its assets would clone a page the report does not
 * describe: caches warm, A/B branches flip, and lazily built markup differs.
 *
 * What gets localised is decided by the network log rather than by parsing the
 * markup. The log is the only record of what the browser actually fetched, so
 * rewriting known URLs needs no HTML or CSS parser and cannot be fooled by an
 * attribute syntax nobody thought of. URLs a script builds at runtime are the
 * documented limit of that approach, and they are counted in the manifest.
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, posix, resolve, sep } from 'node:path';
import { stat } from 'node:fs/promises';

import { fromRgb } from './oklch.js';
import { SNAPSHOT } from './probe.js';

/**
 * Saved in this order, so a size cap cuts what matters least.
 *
 * `Document` covers sub-frames. An iframe left pointing at the original origin
 * is blocked the moment it is framed from somewhere else, and it fails on every
 * load of the clone thereafter.
 */
const PRIORITY = ['Stylesheet', 'Font', 'Image', 'Document', 'Media', 'Manifest', 'Script'];

/** Rewritten as text rather than copied as bytes. */
const TEXTUAL = new Set(['Stylesheet', 'Document']);

/** Extensionless urls need one, or the local server cannot type the response. */
const EXTENSION_FOR = {
  'text/css': '.css',
  'text/javascript': '.js',
  'application/javascript': '.js',
  'application/json': '.json',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'font/woff2': '.woff2',
  'font/woff': '.woff',
  'font/ttf': '.ttf',
  'application/manifest+json': '.webmanifest',
};

const TYPE_FOR = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const short = (text) => createHash('sha1').update(text).digest('hex').slice(0, 8);

/** One path segment, stripped of anything that could escape the output directory. */
const segment = (raw) => raw.replace(/[^\w.-]+/g, '-').replace(/^\.+/, '').slice(0, 80) || 'x';

/**
 * Stable local path for a url.
 *
 * The query string is folded into the filename: `?v=1` and `?v=2` are different
 * resources and must not collide on one path.
 */
function localPath(rawUrl, mimeType) {
  const url = new URL(rawUrl);
  const parts = url.pathname.split('/').filter((part) => part && part !== '.' && part !== '..').map(segment);
  if (parts.length === 0) parts.push('index');

  let file = parts.pop();
  if (url.search) {
    const suffix = extname(file);
    file = `${suffix ? file.slice(0, -suffix.length) : file}.${short(url.search)}${suffix}`;
  }
  if (!extname(file)) file += EXTENSION_FOR[String(mimeType).split(';')[0]] ?? '';

  return posix.join('assets', segment(url.host), ...parts, file);
}

/**
 * Every spelling of one url that could appear inside a file served from
 * `holderOrigin`.
 *
 * A root-relative path resolves against the origin of the file that contains
 * it, not the page's. A stylesheet on a CDN referring to `/fonts/x.woff2` means
 * the CDN's root, so the holder decides whether that spelling is even valid.
 */
function spellings(rawUrl, holderOrigin) {
  const url = new URL(rawUrl);
  const found = [rawUrl, rawUrl.replace(/&/g, '&amp;'), `//${url.host}${url.pathname}${url.search}`];
  if (url.origin === holderOrigin && url.pathname.length > 1) found.push(url.pathname + url.search);
  return found;
}

/** Rewrites every known url in `text` to a path relative to the file holding it. */
function localise(text, holder, holderOrigin, replacements) {
  let rewritten = text;
  for (const { url, path } of replacements) {
    let target = posix.relative(posix.dirname(holder), path);
    if (!target.startsWith('.')) target = `./${target}`;
    for (const form of spellings(url, holderOrigin)) rewritten = rewritten.replaceAll(form, target);
  }
  return rewritten;
}

/**
 * Writes a runnable copy of the loaded page.
 *
 * @param {object} session live CDP session, still on the inspected page
 * @param {object} options
 * @returns {Promise<object>} manifest describing what was written and what was not
 */
export async function captureClone(session, { assets, pageUrl, outDir, keepScripts = false, maxBytes = 40 * 1024 * 1024 }) {
  const snapshot = await session.send('Runtime.evaluate', { expression: SNAPSHOT, returnByValue: true });
  if (snapshot.exceptionDetails) {
    throw new Error(`snapshot failed: ${snapshot.exceptionDetails.text}`);
  }
  const { html, notes } = snapshot.result.value;

  const savable = assets
    .filter(
      (asset) =>
        PRIORITY.includes(asset.type) &&
        !asset.failed &&
        asset.url.startsWith('http') &&
        // The main document is replaced by the rendered snapshot, not copied.
        asset.url !== pageUrl,
    )
    .sort((a, b) => PRIORITY.indexOf(a.type) - PRIORITY.indexOf(b.type));

  const pageOrigin = new URL(pageUrl).origin;
  const written = [];
  const skipped = [];
  const replacements = [];
  const textual = [];
  let bytes = 0;

  for (const asset of savable) {
    if (bytes >= maxBytes) {
      skipped.push({ url: asset.url, reason: 'size budget exhausted' });
      continue;
    }

    let unavailable = null;
    const body = await session
      .send('Network.getResponseBody', { requestId: asset.requestId })
      .catch((error) => {
        unavailable = error.message;
        return null;
      });

    if (!body) {
      skipped.push({ url: asset.url, reason: unavailable });
      continue;
    }

    const path = localPath(asset.url, asset.mimeType);
    const content = body.base64Encoded ? Buffer.from(body.body, 'base64') : Buffer.from(body.body, 'utf8');
    bytes += content.length;

    replacements.push({ url: asset.url, path });
    // Text is rewritten only once the map is complete: a sheet can reference a
    // font that has not been walked yet.
    if (TEXTUAL.has(asset.type)) {
      textual.push({ path, type: asset.type, origin: new URL(asset.url).origin, text: content.toString('utf8') });
    } else {
      written.push({ path, content, type: asset.type });
    }
  }

  for (const file of textual) {
    written.push({
      path: file.path,
      type: file.type,
      content: Buffer.from(localise(file.text, file.path, file.origin, replacements), 'utf8'),
    });
  }

  let document = localise(html, 'index.html', pageOrigin, replacements);
  // A <base> would send every relative path back to the original origin.
  document = document.replace(/<base\b[^>]*>/gi, '');
  // Hints only describe loading. Kept, they 404 locally and pollute a re-inspection.
  document = document.replace(
    /<link\b[^>]*\brel\s*=\s*["']?(?:preload|modulepreload|prefetch|prerender|preconnect|dns-prefetch)["']?[^>]*>/gi,
    '',
  );
  // The origin's own policy can only break a copy of it: a CSP naming the
  // original's hosts blocks every local file, and an integrity hash on a
  // stylesheet fails the moment the reference is rewritten.
  document = document.replace(
    /<meta\b[^>]*\bhttp-equiv\s*=\s*["']?content-security-policy(?:-report-only)?["']?[^>]*>/gi,
    '',
  );
  document = document.replace(/\sintegrity\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // A duplicate attribute loses to the first, so this disables without deleting.
  if (!keepScripts) {
    document = document.replace(/<script\b/gi, '<script type="text/plain" data-design-os="disabled"');
  }

  // A frame whose body could not be copied is unreachable: cross-origin frames
  // run in their own renderer, and the page session cannot read them. Left
  // pointing at the origin it is blocked on every future load of the clone, so
  // the address is kept as data and the frame is emptied instead.
  let frames = 0;
  document = document.replace(/<iframe\b[^>]*>/gi, (tag) => {
    const emptied = tag.replace(/\ssrc\s*=\s*(["']?)(https?:\/\/[^"'\s>]*)\1/i, ' data-design-os-src="$2"');
    if (emptied !== tag) frames += 1;
    return emptied;
  });

  await mkdir(outDir, { recursive: true });
  for (const file of written) {
    const target = join(outDir, ...file.path.split('/'));
    if (!resolve(target).startsWith(resolve(outDir) + sep)) {
      skipped.push({ url: file.path, reason: 'path escapes the output directory' });
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
  await writeFile(join(outDir, 'index.html'), document, 'utf8');

  const byType = {};
  for (const file of written) byType[file.type] = (byType[file.type] ?? 0) + 1;

  return {
    dir: outDir,
    entry: join(outDir, 'index.html'),
    files: written.length + 1,
    bytes,
    byType,
    documentBytes: document.length,
    scripts: keepScripts ? 'kept' : 'disabled',
    framesEmptied: frames,
    // What the CSSOM held and serialization would otherwise have dropped.
    materialised: notes,
    skipped,
  };
}

/**
 * Serves a directory over an ephemeral port.
 *
 * A clone is verified by loading it, and `file://` blocks font and stylesheet
 * requests that a real origin allows, so verification over http is the only way
 * to see the clone the way a browser would.
 */
export function serveDirectory(root) {
  const base = resolve(root);

  const server = createServer(async (request, response) => {
    const requested = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    let target = resolve(join(base, requested === '/' ? 'index.html' : requested));

    if (target !== base && !target.startsWith(base + sep)) {
      response.writeHead(403).end('forbidden');
      return;
    }

    const found = await stat(target).catch(() => null);
    if (found?.isDirectory()) target = join(target, 'index.html');
    if (!found) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }

    response.writeHead(200, {
      'content-type': TYPE_FOR[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'access-control-allow-origin': '*',
    });
    createReadStream(target).pipe(response);
  });

  return new Promise((ready) => {
    server.listen(0, '127.0.0.1', () => {
      ready({
        url: `http://127.0.0.1:${server.address().port}/`,
        close: () => new Promise((closed) => server.close(closed)),
      });
    });
  });
}

const values = (rows) => (rows ?? []).map((row) => (typeof row === 'string' ? row : row.value ?? row.hex));

/**
 * Perceptual distance between two hex colours, in OKLab.
 *
 * Rounding a colour through a clone can move it by one unit per channel. Judged
 * as strings those are different colours; to an eye they are the same one, and a
 * fidelity score that calls them a total mismatch is measuring the wrong thing.
 */
const JUST_NOTICEABLE = 0.03;

function oklab(hex) {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(String(hex));
  if (!match) return null;
  const [r, g, b] = match.slice(1).map((pair) => Number.parseInt(pair, 16));
  const { l, c, h } = fromRgb(r, g, b);
  const radians = (h * Math.PI) / 180;
  return [l, c * Math.cos(radians), c * Math.sin(radians)];
}

function sameColour(first, second) {
  if (first === second) return true;
  const a = oklab(first);
  const b = oklab(second);
  if (!a || !b) return false;
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < JUST_NOTICEABLE;
}

/** Share of `wanted` that also appears in `got`, comparing colours perceptually. */
function overlap(wanted, got, colour = false) {
  const target = values(wanted);
  if (target.length === 0) return 1;
  const present = values(got);
  const matches = colour
    ? target.filter((entry) => present.some((candidate) => sameColour(entry, candidate)))
    : target.filter((entry) => present.includes(entry));
  return matches.length / target.length;
}

/**
 * Scores a clone against its original by re-reading the design from both.
 *
 * Comparing pixels answers whether two images differ; comparing the extracted
 * design answers whether the clone carries the same palette, type and layout —
 * which is what the clone was made to preserve.
 */
export function compareDesign(original, clone) {
  const a = original.direction.observed;
  const b = clone.direction.observed;

  const checks = {
    surface: sameColour(a.surface.hex, b.surface.hex) ? 1 : 0,
    accent: a.accent && b.accent ? (sameColour(a.accent.hex, b.accent.hex) ? 1 : 0) : Number(!a.accent === !b.accent),
    palette: overlap(a.palette.slice(0, 6), b.palette, true),
    families: overlap(a.families.slice(0, 3), b.families),
    typeScale: a.typeScale.ratio === b.typeScale.ratio ? 1 : 0,
    radii: overlap(a.radii.slice(0, 3), b.radii),
    spacing: overlap(a.spacing.slice(0, 4), b.spacing),
    polarity: original.direction.axes.polarity === clone.direction.axes.polarity ? 1 : 0,
    elements: ratio(original.runtime.layout.elements, clone.runtime.layout.elements),
    depth: ratio(original.runtime.layout.maxDepth, clone.runtime.layout.maxDepth),
    grids: ratio(original.runtime.layout.grids, clone.runtime.layout.grids),
    flexes: ratio(original.runtime.layout.flexes, clone.runtime.layout.flexes),
  };

  const scores = Object.values(checks);
  return {
    score: Number((scores.reduce((total, value) => total + value, 0) / scores.length).toFixed(3)),
    checks: Object.fromEntries(Object.entries(checks).map(([name, value]) => [name, Number(value.toFixed(3))])),
    weakest: Object.entries(checks)
      .filter(([, value]) => value < 0.9)
      .sort((x, y) => x[1] - y[1])
      .map(([name, value]) => `${name} ${Math.round(value * 100)}%`),
  };
}

function ratio(expected, actual) {
  if (!expected && !actual) return 1;
  if (!expected || !actual) return 0;
  return Math.min(expected, actual) / Math.max(expected, actual);
}
