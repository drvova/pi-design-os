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

import { HINT_RELS } from './inspect-hints.js';
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

/**
 * Assets Chrome files under `Other`.
 *
 * Resource type records why a request happened, not what came back. A favicon
 * is fetched by the browser rather than by the markup, so it arrives as `Other`
 * and a type-only filter drops it — the clone then 404s on every load. Taking
 * all of `Other` would sweep in beacons and violation reports, so the response's
 * own mime type decides.
 */
const ASSET_MIME = /^(?:image|font|audio|video)\/|^text\/css|^application\/(?:font|manifest)/i;

const isAsset = (asset) =>
  PRIORITY.includes(asset.type) || (asset.type === 'Other' && ASSET_MIME.test(String(asset.mimeType)));

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
function localPath(rawUrl, mimeType, root = 'assets') {
  const url = new URL(rawUrl);
  const parts = url.pathname.split('/').filter((part) => part && part !== '.' && part !== '..').map(segment);
  if (parts.length === 0) parts.push('index');

  let file = parts.pop();
  if (url.search) {
    const suffix = extname(file);
    file = `${suffix ? file.slice(0, -suffix.length) : file}.${short(url.search)}${suffix}`;
  }
  if (!extname(file)) file += EXTENSION_FOR[String(mimeType).split(';')[0]] ?? '';

  return posix.join(root, segment(url.host), ...parts, file);
}

/**
 * Where each kind of asset lives, per layout.
 *
 * `flat` mirrors the origin under one folder. `fsd` files assets by what they
 * are: a font is not a stylesheet, and Feature-Sliced Design puts both in
 * `shared`, which holds segments directly because it has no business domains.
 */
const BUCKETS = {
  Stylesheet: 'shared/vendor',
  Script: 'shared/vendor',
  Document: 'shared/frames',
  Font: 'shared/fonts',
  Image: 'shared/images',
  Media: 'shared/media',
  Manifest: 'shared/config',
};

export const LAYOUTS = {
  flat: {
    assetRoot: () => 'assets',
    route: (url) => routeSegments(url).join('/') || 'index.html',
  },
  fsd: {
    assetRoot: (asset) =>
      BUCKETS[asset.type] ?? (/^image\//i.test(String(asset.mimeType)) ? 'shared/images' : 'shared/vendor'),
    // Every route is a slice of the pages layer, and its markup is its ui segment.
    route: (url) => posix.join('pages', routeSlug(url), 'ui', 'index.html'),
  },
};

/** The pathname a file was served from, sanitised but otherwise untouched. */
function originPath(rawUrl, mimeType) {
  const url = new URL(rawUrl);
  const parts = url.pathname.split('/').filter((part) => part && part !== '.' && part !== '..').map(segment);
  if (parts.length === 0) parts.push('index');

  let file = parts.pop();
  if (!extname(file)) file += EXTENSION_FOR[String(mimeType).split(';')[0]] ?? '';
  return posix.join(...parts, file);
}

/** Directory form, so `/docs` and `/docs/install` cannot collide on one path. */
function routeSegments(rawUrl) {
  const url = new URL(rawUrl);
  const parts = url.pathname.split('/').filter((part) => part && part !== '.' && part !== '..').map(segment);
  if (parts.length === 0) return ['index.html'];
  if (url.search) parts.push(short(url.search));
  if (/\.x?html?$/i.test(parts.at(-1))) return parts;
  return [...parts, 'index.html'];
}

/** One flat slice name for a route, since slices do not nest within a layer. */
function routeSlug(rawUrl) {
  const url = new URL(rawUrl);
  const parts = url.pathname.split('/').filter((part) => part && part !== '.' && part !== '..').map(segment);
  if (url.search) parts.push(short(url.search));
  return parts.join('-').replace(/\.x?html?$/i, '') || 'home';
}

/**
 * Local html file for a route.
 *
 * @param {string} rawUrl
 * @param {'flat'|'fsd'} layout
 */
export function routePath(rawUrl, layout = 'flat') {
  return LAYOUTS[layout].route(rawUrl);
}

/**
 * Every spelling of one url that could appear inside a file served from
 * `holderOrigin`.
 *
 * A root-relative path resolves against the origin of the file that contains
 * it, not the page's. A stylesheet on a CDN referring to `/fonts/x.woff2` means
 * the CDN's root, so the holder decides whether that spelling is even valid.
 */
function spellings(rawUrl, holderUrl) {
  const url = new URL(rawUrl);
  const holder = new URL(holderUrl);
  const found = [rawUrl, rawUrl.replace(/&/g, '&amp;'), `//${url.host}${url.pathname}${url.search}`];
  if (url.origin !== holder.origin) return found;

  if (url.pathname.length > 1) found.push(url.pathname + url.search);

  // Document-relative, resolved from the file that holds the reference, the way
  // a browser resolves it. svelte.dev writes `./_app/x.css`, and a rewriter that
  // knows only the root-relative form matches one character in and leaves a path
  // beginning `.../`.
  const from = posix.dirname(holder.pathname);
  const relative = posix.relative(from, url.pathname);
  if (relative) {
    // A `../` form is the correct relative reference for any page below the
    // root, so it belongs here as much as the `./` one does.
    found.push(relative.startsWith('..') ? relative : `./${relative}`, relative);
  }
  return found;
}

const escape = (literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Characters that can legally end a url reference.
 *
 * A reference is a delimited token, not a substring, and treating it as one is
 * what makes `/docs` stop short of `/docs/installation`. A fragment or a query
 * may follow, because both address the same document and both survive the
 * rewrite; a path separator may not, because it names a different one.
 */
const REFERENCE_END = '(?=[\'"\\s)>,;#?]|$)';

/**
 * And a reference has to start at one too.
 *
 * The end was guarded and the start was not, which is the same mistake twice.
 * A document-relative `./_app/x.css` contains the root-relative `/_app/x.css`
 * one character in, so the rewrite landed after the dot and produced
 * `.../../../shared/x.css` — a path with three leading dots that resolves
 * nowhere. Anything that could continue a path to the left means the match is
 * in the middle of a longer reference, not at the beginning of one.
 */
const REFERENCE_START = '(?<![\\w.\\-/])';

/**
 * Rewrites every known url in `text` to a path relative to the file holding it.
 *
 * Two rules, and both are needed.
 *
 * A match must end at a delimiter. Without that, the entry url is a prefix of
 * every absolute url on its own site, so `https://x.com/` rewrites the front of
 * `https://x.com/plus` and leaves `./index.htmlplus`. The same happens to any
 * route that prefixes an uncloned one: `/docs` sits inside `/docs/installation`
 * and there is no longer alternative to prefer, because that page was never
 * cloned.
 *
 * And it must be one pass. Replacing in sequence is unsafe in both directions:
 * the short url first splices its path into the middle of the long one, and the
 * long url first leaves `./docs/install/index.html`, which the short url then
 * matches inside the result just written. A single alternation, longest branch
 * first, visits each character once and never revisits a substitution.
 */
export function localise(text, holder, holderUrl, replacements) {
  const targets = new Map();

  for (const { url, path } of replacements) {
    let target = posix.relative(posix.dirname(holder), path);
    if (!target.startsWith('.')) target = `./${target}`;
    for (const form of spellings(url, holderUrl)) if (!targets.has(form)) targets.set(form, target);
  }
  if (targets.size === 0) return text;

  // Alternation is tried left to right, so longest first means longest wins.
  const ordered = [...targets.keys()].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`${REFERENCE_START}(?:${ordered.map(escape).join('|')})${REFERENCE_END}`, 'g');
  return text.replace(pattern, (matched) => targets.get(matched));
}

/**
 * Writes a runnable copy of the loaded page.
 *
 * @param {object} session live CDP session, still on the inspected page
 * @param {object} options
 * @returns {Promise<object>} manifest describing what was written and what was not
 */
export async function captureClone(session, {
  assets,
  pageUrl,
  outDir,
  holder = 'index.html',
  saved = new Map(),
  layout = 'flat',
  keepScripts = false,
  sourceHtml = '',
  maxBytes = 40 * 1024 * 1024,
}) {
  // Keeping the scripts changes what a copy has to be.
  //
  // A framework hydrates against the markup its server sent, so handing it the
  // DOM that hydration already produced makes React tear the tree down: the page
  // collapsed from 132 elements to 12. And a chunk loader builds its urls at
  // runtime, so no rewriter can ever see them -- emilkowal.ski's builds twelve
  // more `/_next/...` paths after load, on top of the thirty-one in its markup.
  //
  // Both are answered the same way: serve the site's own shape. Mirror mode
  // keeps the server's html and writes same-origin assets at the pathname they
  // were served from, so a root-relative url resolves whether it came from the
  // markup or from a script. Cross-origin assets are still filed and rewritten,
  // because nothing on this origin will ever construct those.
  const mirror = keepScripts;
  const snapshot = mirror ? null : await session.send('Runtime.evaluate', { expression: SNAPSHOT, returnByValue: true });
  if (snapshot?.exceptionDetails) {
    throw new Error(`snapshot failed: ${snapshot.exceptionDetails.text}`);
  }
  if (mirror && !sourceHtml) {
    throw new Error('mirror mode needs the served html; the document body was not available');
  }

  const { html, notes } = mirror
    ? { html: sourceHtml, notes: { mirrored: true, inlineSheets: 0, adoptedSheets: 0, rules: 0, unreadable: 0, fields: 0, shadowRoots: 0, closedHosts: 0, canvases: 0, canvasBytes: 0, animations: 0, posters: 0 } }
    : snapshot.result.value;

  const savable = assets
    .filter(
      (asset) =>
        isAsset(asset) &&
        !asset.failed &&
        asset.url.startsWith('http') &&
        // The main document is replaced by the rendered snapshot, not copied.
        asset.url !== pageUrl,
    )
    // An untyped asset sits with images: wanted, but after stylesheets and fonts.
    .sort((a, b) => (PRIORITY.indexOf(a.type) + 1 || 3) - (PRIORITY.indexOf(b.type) + 1 || 3));

  const pageOrigin = new URL(pageUrl).origin;
  const written = [];
  const skipped = [];
  const replacements = [];
  const textual = [];
  let bytes = 0;
  let reused = 0;

  for (const asset of savable) {
    // Routes of one site share almost every asset. A url already written keeps
    // its path, so the reference still rewrites, but the body is not fetched
    // again: each route runs in a fresh browser with a cold cache.
    const already = saved.get(asset.url);
    if (already) {
      replacements.push({ url: asset.url, path: already });
      reused += 1;
      continue;
    }

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

    // Same-origin, in mirror mode: keep the served pathname, so a url a script
    // builds at runtime finds the file exactly where the origin had it.
    const sameOrigin = new URL(asset.url).origin === pageOrigin;
    const path =
      mirror && sameOrigin
        ? originPath(asset.url, asset.mimeType)
        : localPath(asset.url, asset.mimeType, LAYOUTS[layout].assetRoot(asset));
    const content = body.base64Encoded ? Buffer.from(body.body, 'base64') : Buffer.from(body.body, 'utf8');
    bytes += content.length;

    // A same-origin reference already resolves in mirror mode; rewriting it to a
    // relative path would only break the runtime-built ones that look identical.
    if (!(mirror && sameOrigin)) replacements.push({ url: asset.url, path });
    saved.set(asset.url, path);
    // Text is rewritten only once the map is complete: a sheet can reference a
    // font that has not been walked yet.
    if (TEXTUAL.has(asset.type)) {
      // The sheet's own url, not just its origin: a reference inside it resolves
      // from the directory the sheet was served from.
      textual.push({ path, type: asset.type, from: asset.url, text: content.toString('utf8') });
    } else {
      written.push({ path, content, type: asset.type });
    }
  }

  for (const file of textual) {
    written.push({
      path: file.path,
      type: file.type,
      content: Buffer.from(localise(file.text, file.path, file.from, replacements), 'utf8'),
    });
  }

  let document = localise(html, holder, pageUrl, replacements);
  // A <base> would send every relative path back to the original origin.
  document = document.replace(/<base\b[^>]*>/gi, '');
  // Hints only describe loading. In a snapshot they 404 and pollute a
  // re-inspection; in a mirror they point at files that are now really there.
  //
  // `rel` is a token list, and a link can be a hint and a stylesheet at once:
  // Vite emits `rel="preload stylesheet"`. Matching the word `preload` anywhere
  // in the attribute deleted those outright, which took every stylesheet with
  // them -- vuejs.org cloned with 757 elements and not one rule applied to any
  // of them. A link is only a hint when nothing in its rel does anything else.
  if (!mirror) {
    document = document.replace(/<link\b[^>]*>/gi, (tag) => {
      const rel = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
      if (!rel) return tag;

      const tokens = (rel[1] ?? rel[2] ?? rel[3] ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const onlyHints = tokens.length > 0 && tokens.every((token) => HINT_RELS.has(token));
      return onlyHints ? '' : tag;
    });
  }
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
  const entry = join(outDir, ...holder.split('/'));
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, document, 'utf8');

  const byType = {};
  for (const file of written) byType[file.type] = (byType[file.type] ?? 0) + 1;

  return {
    dir: outDir,
    entry,
    holder,
    layout,
    replacements,
    pageOrigin,
    files: written.length + 1,
    bytes,
    reused,
    byType,
    documentBytes: document.length,
    mode: mirror ? 'mirror' : 'snapshot',
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
