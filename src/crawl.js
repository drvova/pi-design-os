/**
 * Multi-route cloning.
 *
 * A single page is not a site. Routes are discovered from the rendered DOM
 * rather than from a sitemap or a framework manifest: anchors read after
 * hydration are the destinations the site itself offers, whatever built them,
 * and no framework-specific knowledge is needed to find them.
 *
 * Each route is its own navigation, because that is the only way to see a route
 * as the browser builds it. Assets are shared through one ledger, so the second
 * route pays for nothing the first already saved — every route runs in a fresh
 * browser with a cold cache, and without the ledger a ten-route clone would
 * download the same stylesheet ten times.
 *
 * Links between routes are rewritten in a second pass. While the first route is
 * being captured there is no way to know which of its destinations will end up
 * cloned, so a link can only be pointed at a local file once the crawl has
 * finished and the set of routes is closed.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';

import {
  compareDesign,
  localise,
  routePath,
  serveDirectory,
} from './clone.js';
import { progress } from './envelope.js';
import { inspectPage, normaliseUrl } from './inspect.js';
import { writeAppStyles, writeEntry, writeManifest, writeReadme } from './slices.js';

/** Linked, but never a page: following these wastes a browser launch. */
const NOT_A_DOCUMENT =
  /\.(?:png|jpe?g|gif|webp|avif|svg|ico|pdf|zip|gz|tgz|dmg|exe|mp4|webm|mp3|wav|woff2?|ttf|otf|css|js|mjs|json|xml|txt|csv|rss|atom)$/i;

/** Same site, plausibly a page, not seen before. */
function crawlable(candidate, origin, seen) {
  if (!candidate.startsWith(`${origin}/`) && candidate !== origin) return false;
  if (seen.has(candidate)) return false;
  return !NOT_A_DOCUMENT.test(new URL(candidate).pathname);
}

/**
 * Points `href="/"` at the entry route.
 *
 * A root-relative spelling is only safe to replace when it is a real path;
 * rewriting a bare `/` everywhere would hit every other path in the document.
 * The home link is the one case worth handling, and only inside an anchor.
 */
function relinkHome(html, holder, homePath) {
  let target = posix.relative(posix.dirname(holder), homePath);
  if (!target.startsWith('.')) target = `./${target}`;
  return html.replace(/(<a\b[^>]*\shref\s*=\s*)(["'])\/\2/gi, `$1$2${target}$2`);
}

/**
 * Where the anchors in a rewritten document actually point.
 *
 * A link still addressing the site is unresolved, however it is spelled: it is
 * a page the crawl did not reach, not a link somewhere else.
 */
function countLinks(html, origin) {
  const counted = { rewritten: 0, external: 0, unresolved: 0 };
  for (const match of html.matchAll(/<a\b[^>]*\shref\s*=\s*["']([^"']*)["']/gi)) {
    const href = match[1];
    if (href.startsWith('.')) counted.rewritten += 1;
    else if (href.startsWith('/') && !href.startsWith('//')) counted.unresolved += 1;
    else if (href.startsWith(origin) || href.startsWith(`//${new URL(origin).host}`)) counted.unresolved += 1;
    else if (/^(?:https?:)?\/\//i.test(href)) counted.external += 1;
  }
  return counted;
}

const mean = (numbers) => numbers.reduce((total, value) => total + value, 0) / numbers.length;

/**
 * Clones a site breadth-first from one entry url.
 *
 * @param {object} options
 * @returns {Promise<object>} manifest, with the entry route's full report
 */
export async function cloneSite({
  url,
  dir,
  routes = 1,
  wait = 15000,
  timeout = 30000,
  scripts = false,
  maxBytes = 40 * 1024 * 1024,
  screenshot = false,
  verify = true,
  layout = 'flat',
}) {
  const entry = normaliseUrl(url);
  const origin = new URL(entry).origin;

  const saved = new Map();
  const sliceLedger = new Map();
  const captured = new Map();
  const queued = new Set([entry]);
  const order = [entry];
  let discovered = 1;

  // Breadth-first, so a route cap keeps the pages nearest the entry rather than
  // whichever branch happened to be walked first.
  while (order.length > 0 && captured.size < routes) {
    const next = order.shift();
    const holder = routePath(next, layout);

    progress(`[${captured.size + 1}/${routes}] ${next}`);
    const report = await inspectPage({
      url: next,
      wait,
      timeout,
      screenshot: screenshot && next === entry,
      clone: {
        dir,
        holder,
        saved,
        layout,
        scripts,
        maxBytes,
        slices: layout === 'fsd' ? { ledger: sliceLedger, routeMarker: holder } : undefined,
      },
    });
    captured.set(next, { report, holder });

    for (const link of report.links ?? []) {
      if (!crawlable(link, origin, queued)) continue;
      queued.add(link);
      order.push(link);
      discovered += 1;
    }
  }

  // Second pass: the set of routes is only closed now, so only now can a link
  // between two of them be pointed at a file.
  const replacements = [...captured].map(([routeUrl, { holder }]) => ({ url: routeUrl, path: holder }));
  const links = { rewritten: 0, external: 0, unresolved: 0 };
  const homePath = captured.get(entry)?.holder;

  for (const [routeUrl, { holder }] of captured) {
    const path = `${dir}/${holder}`;
    const before = await readFile(path, 'utf8');
    let after = localise(before, holder, routeUrl, replacements);
    if (homePath) after = relinkHome(after, holder, homePath);
    if (after !== before) await writeFile(path, after, 'utf8');

    const counted = countLinks(after, origin);
    for (const key of Object.keys(links)) links[key] += counted[key];
  }

  const entryReport = captured.get(entry).report;

  // The layer files describe the whole clone, so they are written once the set
  // of routes and the ledger of slices are both closed.
  let layers = null;
  if (layout === 'fsd') {
    layers = await writeAppStyles(
      dir,
      entryReport.sheetTexts ?? [],
      origin,
      entryReport.cloneReplacements ?? [],
      entryReport.shellCss ?? '',
    );
    await writeEntry(dir, captured.get(entry).holder);
  }

  const summaries = [...captured].map(([routeUrl, { report, holder }]) => ({
    url: routeUrl,
    path: holder,
    title: report.title,
    files: report.clone.files,
    bytes: report.clone.bytes,
    reused: report.clone.reused,
    cssomRules: report.clone.materialised.rules,
    framesEmptied: report.clone.framesEmptied,
    skipped: report.clone.skipped.length,
    capture: report.capture,
    fidelity: null,
  }));

  if (verify) {
    const server = await serveDirectory(dir);
    try {
      for (const summary of summaries) {
        progress(`Verifying ${summary.path}…`);
        const replica = await inspectPage({
          url: new URL(summary.path, server.url).href,
          wait: Math.min(wait, 8000),
          timeout,
        });
        const scored = compareDesign(captured.get(summary.url).report, replica);
        summary.fidelity = { ...scored, replica: replica.capture };
      }
    } finally {
      await server.close();
    }
  }

  const scores = summaries.map((summary) => summary.fidelity?.score).filter((score) => score !== undefined && score !== null);
  const worst = summaries
    .filter((summary) => summary.fidelity)
    .sort((a, b) => a.fidelity.score - b.fidelity.score)[0];

  const manifest = {
    source: entry,
    dir,
    capturedAt: new Date().toISOString(),
    layout,
    discovered,
    routes: summaries.map((summary) => ({ path: summary.path, url: summary.url, title: summary.title })),
    slices: [...sliceLedger.values()],
    assets: { unique: saved.size },
  };

  if (layout === 'fsd') {
    await writeManifest(dir, manifest);
    await writeReadme(dir, manifest);
  }

  return {
    dir,
    layout,
    entry: layout === 'fsd' ? `${dir}/index.html` : entryReport.clone.entry,
    layers,
    slices: manifest.slices,
    requested: routes,
    cloned: captured.size,
    discovered,
    // Destinations found but not cloned: the cap, or a link off the site.
    remaining: order.length,
    assets: { unique: saved.size, bytes: summaries.reduce((total, row) => total + row.bytes, 0) },
    links,
    routes: summaries,
    fidelity: scores.length === 0
      ? null
      : {
          score: Number(mean(scores).toFixed(3)),
          lowest: Number(Math.min(...scores).toFixed(3)),
          // The average hides a single broken route; the worst one does not.
          lowestRoute: worst.path,
          weakest: worst.fidelity.weakest,
        },
    entryReport,
  };
}
