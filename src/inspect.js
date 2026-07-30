/**
 * Page rendering-pipeline forensics.
 *
 * One navigation answers everything. Instrumentation is installed before the
 * first byte of the document is parsed, the network and CSS domains record what
 * the browser fetched and in what order, and a single post-load evaluation reads
 * the accumulated counters back out. Running the page twice would measure two
 * different pages: caches warm, A/B branches flip, and lazy work that ran the
 * first time does not run the second.
 *
 * Phases come from `document.readyState`, which is the platform's own answer to
 * the question and cannot drift from it:
 *
 *   loading      parser is running, no DOMContentLoaded yet   -> pre-DOM
 *   interactive  DOMContentLoaded fired, subresources pending -> post-DOM
 *   complete     load fired                                   -> post-load
 *
 * Authored markup answers what the parser was told to do; the live DOM answers
 * what the page became. The difference between the two is the work JavaScript
 * did, which is precisely what a design engineer needs to separate a CSS effect
 * from a scripted one.
 */

import { captureClone } from './clone.js';
import { collectSlices, writeSlices } from './slices.js';
import { openPage } from './cdp.js';
import { CommandError } from './envelope.js';
import { toDirection } from './extract.js';
import { HARVEST, PROBE, REVEAL, resolveTokens } from './probe.js';

/** Fixed viewport: area-weighted colour extraction is only comparable at a fixed size. */
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };

/** Stylesheet bodies are fetched one round trip each; large sites have hundreds. */
const MAX_STYLESHEETS = 40;

/** A design system rarely exceeds this; the cap bounds a pathological sheet. */
const MAX_TOKENS = 400;

/**
 * Above this share of failed requests a capture is not describing the site as
 * built. A page whose scripts were blocked looks like a static CSS page, and
 * every downstream conclusion drawn from it would be confidently wrong.
 */
const DEGRADED_FAILURE_RATE = 0.1;

const HINT_RELS = new Set(['preconnect', 'dns-prefetch', 'preload', 'modulepreload', 'prefetch', 'prerender']);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function normaliseUrl(raw) {
  if (!raw) throw new CommandError('USAGE_ERROR', 'a url is required.');
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new CommandError('USAGE_ERROR', `not a valid url: ${raw}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CommandError('USAGE_ERROR', `only http and https are supported, got ${parsed.protocol}`);
  }
  return parsed.href;
}

/** Attribute pairs out of a raw tag body. */
function attributes(source) {
  const found = {};
  for (const match of source.matchAll(/([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    found[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return found;
}

/**
 * What the parser was handed, in source order.
 *
 * This is the pre-DOM phase stated exactly: every hint, sheet and script the
 * browser saw before it had a DOM to work with, still in the order it saw them.
 */
export function authored(html) {
  const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html);
  const source = head ? head[1] : html.slice(0, 32000);

  const hints = [];
  const stylesheets = [];
  const meta = {};

  for (const match of source.matchAll(/<(link|meta|base)\b([^>]*)>/gi)) {
    const attrs = attributes(match[2]);
    const tag = match[1].toLowerCase();

    if (tag === 'meta') {
      const key = attrs.name ?? attrs.property ?? (attrs.charset !== undefined ? 'charset' : null);
      if (key) meta[key] = attrs.content ?? attrs.charset ?? '';
      continue;
    }
    if (tag !== 'link') continue;

    const rel = (attrs.rel ?? '').toLowerCase();
    if (HINT_RELS.has(rel)) {
      hints.push({ rel, href: attrs.href ?? null, as: attrs.as ?? null, crossorigin: 'crossorigin' in attrs });
    } else if (rel.split(/\s+/).includes('stylesheet')) {
      const media = attrs.media ?? 'all';
      stylesheets.push({ href: attrs.href ?? null, media, renderBlocking: media !== 'print' });
    }
  }

  const scripts = [];
  for (const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = attributes(match[1]);
    const isModule = (attrs.type ?? '').toLowerCase() === 'module';
    const external = Boolean(attrs.src);
    scripts.push({
      src: attrs.src ?? null,
      type: attrs.type || 'classic',
      async: 'async' in attrs,
      defer: 'defer' in attrs || isModule,
      inlineBytes: external ? 0 : match[2].length,
      // A classic external script in head with neither async nor defer halts the parser.
      parserBlocking: external && !('async' in attrs) && !('defer' in attrs) && !isModule,
    });
  }

  const inlineStyles = [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)];

  return {
    hints,
    stylesheets,
    scripts,
    inlineStyleBlocks: inlineStyles.length,
    inlineStyleBytes: inlineStyles.reduce((total, match) => total + match[1].length, 0),
    meta,
    headBytes: source.length,
    documentBytes: html.length,
    parserBlockingScripts: scripts.filter((script) => script.parserBlocking).length,
    renderBlockingStylesheets: stylesheets.filter((sheet) => sheet.renderBlocking).length,
  };
}

/** Countable facts about one stylesheet's text. */
export function cssStats(text) {
  const count = (pattern) => (text.match(pattern) ?? []).length;
  let blocks = 0;
  for (let index = 0; index < text.length; index += 1) if (text[index] === '{') blocks += 1;

  return {
    bytes: text.length,
    blocks,
    mediaQueries: count(/@media\b/gi),
    containerQueries: count(/@container\b/gi),
    supports: count(/@supports\b/gi),
    keyframes: count(/@keyframes\b/gi),
    fontFaces: count(/@font-face\b/gi),
    layers: count(/@layer\b/gi),
    imports: count(/@import\b/gi),
    customProperties: count(/--[\w-]+\s*:/g),
    varUsages: count(/var\(\s*--/g),
    transitions: count(/\btransition(?:-[a-z]+)?\s*:/gi),
    animations: count(/\banimation(?:-[a-z]+)?\s*:/gi),
    hasSelector: count(/:has\(/gi),
    important: count(/!important/gi),
    reducedMotion: count(/prefers-reduced-motion/gi),
    colorScheme: count(/prefers-color-scheme/gi),
  };
}

const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] ?? 0), 0);

/** Counter bags into sorted rows, dropping anything the page never touched. */
function used(bag) {
  return Object.entries(bag ?? {})
    .filter(([, slot]) => slot.total > 0)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([name, slot]) => ({
      name,
      total: slot.total,
      firstAt: slot.firstAt ?? null,
      beforeDomContentLoaded: slot.loading,
      afterDomContentLoaded: slot.interactive,
      afterLoad: slot.complete,
    }));
}

/**
 * Registers every collector before navigation, so nothing early is missed.
 *
 * The page starts on `about:blank`, and enabling lifecycle events makes Chrome
 * replay that document's milestones. Everything here is therefore keyed by
 * `loaderId`: without it the first `DOMContentLoaded` read back belongs to the
 * blank page, and its `networkIdle` would settle the wait before the real
 * navigation had begun.
 */
function collect(session) {
  const requests = new Map();
  const headers = [];
  const lifecycle = [];
  const exceptions = [];
  let reachedIdle;
  const idle = new Promise((resolve) => {
    reachedIdle = resolve;
  });

  session.on('Network.requestWillBeSent', (event) => {
    const existing = requests.get(event.requestId);
    if (existing) {
      existing.redirects += 1;
      existing.url = event.request.url;
      return;
    }
    const stack = event.initiator?.stack?.callFrames?.[0];
    requests.set(event.requestId, {
      requestId: event.requestId,
      url: event.request.url,
      method: event.request.method,
      type: event.type ?? 'Other',
      startedAt: event.timestamp,
      initiator: event.initiator?.type ?? 'unknown',
      initiatorUrl: event.initiator?.url ?? stack?.url ?? null,
      redirects: 0,
      bytes: 0,
    });
  });

  session.on('Network.responseReceived', (event) => {
    const entry = requests.get(event.requestId);
    if (!entry) return;
    entry.type = event.type ?? entry.type;
    entry.status = event.response.status;
    entry.mimeType = event.response.mimeType;
    entry.protocol = event.response.protocol ?? null;
    entry.fromCache = Boolean(event.response.fromDiskCache || event.response.fromPrefetchCache);
    entry.respondedAt = event.timestamp;
  });

  session.on('Network.loadingFinished', (event) => {
    const entry = requests.get(event.requestId);
    if (!entry) return;
    entry.finishedAt = event.timestamp;
    entry.bytes = event.encodedDataLength ?? 0;
  });

  session.on('Network.loadingFailed', (event) => {
    const entry = requests.get(event.requestId);
    if (!entry) return;
    entry.finishedAt = event.timestamp;
    entry.failed = event.errorText;
  });

  session.on('CSS.styleSheetAdded', (event) => headers.push(event.header));
  session.on('Runtime.exceptionThrown', (event) => {
    if (exceptions.length < 40) exceptions.push(event.exceptionDetails.text ?? 'exception');
  });

  let navigationLoader = null;

  session.on('Page.lifecycleEvent', (event) => {
    lifecycle.push({ name: event.name, timestamp: event.timestamp, loaderId: event.loaderId });
    if (event.name === 'networkIdle' && event.loaderId === navigationLoader) reachedIdle();
  });

  return {
    requests,
    headers,
    exceptions,
    idle,
    /** Called with the loaderId `Page.navigate` returns; everything keys off it. */
    navigated(loaderId) {
      navigationLoader = loaderId;
    },
    /** Milestones belonging to the navigation under inspection, in order. */
    milestones() {
      return lifecycle.filter((entry) => entry.loaderId === navigationLoader);
    },
  };
}

/**
 * Loads a url once and reports the whole pipeline.
 *
 * @param {{url:string, wait?:number, timeout?:number, screenshot?:boolean,
 *   clone?:{dir:string, holder?:string, saved?:Map, layout?:string, scripts?:boolean,
 *     maxBytes?:number, slices?:{ledger:Map, routeMarker:string}}}} options
 */
export async function inspectPage({ url, wait = 15000, timeout = 30000, screenshot = false, clone = null }) {
  const target = normaliseUrl(url);
  const session = await openPage({ timeout });

  try {
    const collected = collect(session);

    for (const domain of ['Page', 'Network', 'Runtime', 'DOM', 'CSS', 'Performance']) {
      await session.send(`${domain}.enable`);
    }
    await session.send('Page.setLifecycleEventsEnabled', { enabled: true });
    await session.send('Emulation.setDeviceMetricsOverride', VIEWPORT);
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });

    const navigation = await session.send('Page.navigate', { url: target });
    if (navigation.errorText) {
      throw new CommandError('OPERATION_FAILED', `navigation failed: ${navigation.errorText}`);
    }
    collected.navigated(navigation.loaderId);

    // networkIdle is Chrome's own quiet-period signal; `wait` is the ceiling for
    // pages that poll forever and would otherwise never reach it.
    await Promise.race([collected.idle, delay(wait)]);
    await delay(300);

    const harvested = await session.send('Runtime.evaluate', {
      expression: HARVEST,
      returnByValue: true,
      awaitPromise: false,
    });
    if (harvested.exceptionDetails) {
      throw new CommandError('OPERATION_FAILED', `harvest failed: ${harvested.exceptionDetails.text}`);
    }
    const harvest = harvested.result.value;

    const metrics = Object.fromEntries(
      (await session.send('Performance.getMetrics')).metrics.map((metric) => [metric.name, metric.value]),
    );

    const assets = [...collected.requests.values()];
    const document = assets.find((asset) => asset.type === 'Document') ?? assets[0];
    const origin = document?.startedAt ?? 0;
    const at = (timestamp) => (timestamp === undefined ? null : Math.round((timestamp - origin) * 1000));

    let html = '';
    let htmlUnavailable = null;
    if (document) {
      const body = await session
        .send('Network.getResponseBody', { requestId: document.requestId })
        .catch((error) => {
          htmlUnavailable = error.message;
          return null;
        });
      if (body) html = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
    }

    const sheets = [];
    const sheetTexts = [];
    for (const header of collected.headers.slice(0, MAX_STYLESHEETS)) {
      // A sheet detached between the event and this call has no text to return;
      // the sheet is still listed, with the reason it could not be read.
      let unreadable = null;
      const text = await session
        .send('CSS.getStyleSheetText', { styleSheetId: header.styleSheetId })
        .catch((error) => {
          unreadable = error.message;
          return null;
        });
      if (text) sheetTexts.push(text.text);
      sheets.push({
        url: header.sourceURL || (header.isInline ? 'inline' : 'constructed'),
        origin: header.origin,
        inline: Boolean(header.isInline),
        unreadable,
        ...cssStats(text?.text ?? ''),
      });
    }

    // Names first, from text already fetched; values second, resolved in the page.
    const declared = [...new Set(sheetTexts.flatMap((text) => [...text.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1])))];
    const resolved = await session.send('Runtime.evaluate', {
      expression: resolveTokens(declared.slice(0, MAX_TOKENS)),
      returnByValue: true,
    });
    harvest.design.customProperties = resolved.exceptionDetails ? {} : resolved.result.value;

    let shot = null;
    if (screenshot) {
      shot = (await session.send('Page.captureScreenshot', { format: 'png' })).data;
    }

    // Last, and only last. Snapshotting writes the CSSOM back into the DOM and
    // mirrors field state onto attributes; running it any earlier would put its
    // own mutations into the measurements above.
    // Only now, and only when copying. Walking the page makes lazy images load
    // and reveal observers fire, which is what a complete copy needs and what a
    // faithful measurement must not include: everything above was recorded
    // before this ran, so the pipeline report still describes the page's own
    // behaviour rather than the tool's.
    let revealed = null;
    if (clone) {
      const walked = await session
        .send('Runtime.evaluate', { expression: REVEAL, returnByValue: true, awaitPromise: true })
        .catch((error) => ({ exceptionDetails: { text: error.message } }));
      revealed = walked.exceptionDetails ? { failed: walked.exceptionDetails.text } : walked.result.value;
    }

    // Detection marks the nodes and the CSS domain answers about them, so both
    // must happen while the document is still live and before it is serialized.
    const detected = clone?.slices ? await collectSlices(session) : null;

    const cloned = clone
      ? await captureClone(session, {
          assets,
          pageUrl: harvest.document.url,
          outDir: clone.dir,
          holder: clone.holder,
          saved: clone.saved,
          layout: clone.layout,
          keepScripts: clone.scripts,
          maxBytes: clone.maxBytes,
        })
      : null;

    // Written only now: a slice's markup and css reference the same assets the
    // page does, and those paths are not known until the assets are saved.
    const sliced = detected
      ? await writeSlices(clone.dir, detected, {
          ledger: clone.slices.ledger,
          replacements: cloned.replacements,
          origin: cloned.pageOrigin,
          routeMarker: clone.slices.routeMarker,
        })
      : null;

    const milestones = collected.milestones();
    const milestone = (name) => milestones.find((entry) => entry.name === name)?.timestamp;
    const domContentLoaded = milestone('DOMContentLoaded');
    const loadFired = milestone('load');
    const probe = harvest.probe;

    if (!probe) {
      throw new CommandError(
        'OPERATION_FAILED',
        'the pre-document probe did not install; the page blocked instrumentation.',
      );
    }

    const before = (timestamp) => (boundary) =>
      boundary !== undefined && timestamp !== undefined && timestamp < boundary;
    const startedBeforeDcl = assets.filter((asset) => before(asset.startedAt)(domContentLoaded));
    const startedAfterDcl = assets.filter((asset) => !before(asset.startedAt)(domContentLoaded));
    const dynamicStyling = used(probe.styling);
    const staticDeclarations = sum(sheets, 'blocks');
    const failures = assets.filter((asset) => asset.failed);
    const failureRate = assets.length > 0 ? failures.length / assets.length : 0;

    return {
      url: target,
      finalUrl: harvest.document.url,
      title: harvest.document.title,
      capturedAt: new Date().toISOString(),
      viewport: { width: VIEWPORT.width, height: VIEWPORT.height },

      // Read this before anything else. A degraded load still produces a full
      // report, and every section of it will describe a page that never
      // finished becoming itself.
      capture: {
        requests: assets.length,
        failed: failures.length,
        failureRate: Number(failureRate.toFixed(3)),
        scriptsFailed: failures.filter((asset) => asset.type === 'Script').length,
        degraded: failureRate > DEGRADED_FAILURE_RATE,
        reason:
          failureRate > DEGRADED_FAILURE_RATE
            ? `${failures.length} of ${assets.length} requests failed (${failures[0]?.failed}); treat every other section as describing a partly loaded page`
            : null,
      },

      timeline: {
        milestones: milestones.map((entry) => ({ name: entry.name, at: at(entry.timestamp) })),
        domContentLoadedAt: at(domContentLoaded),
        loadAt: at(loadFired),
        scriptDurationMs: Math.round((metrics.ScriptDuration ?? 0) * 1000),
        styleRecalcMs: Math.round((metrics.RecalcStyleDuration ?? 0) * 1000),
        layoutMs: Math.round((metrics.LayoutDuration ?? 0) * 1000),
        nodes: metrics.Nodes ?? null,
        jsHeapBytes: metrics.JSHeapUsedSize ?? null,
      },

      // 1 — what the parser was handed before a DOM existed.
      preDom: {
        ...authored(html),
        htmlUnavailable,
        requestsBeforeFirstPaint: assets.filter((asset) => before(asset.startedAt)(milestone('firstPaint'))).length,
      },

      // 2 — everything that ran while readyState was still "loading".
      beforeDomContentLoaded: {
        scriptsFetched: startedBeforeDcl.filter((asset) => asset.type === 'Script').length,
        stylesheetsFetched: startedBeforeDcl.filter((asset) => asset.type === 'Stylesheet').length,
        requests: startedBeforeDcl.length,
        bytes: sum(startedBeforeDcl, 'bytes'),
        apiCalls: used(probe.apis).filter((row) => row.beforeDomContentLoaded > 0)
          .map((row) => ({ name: row.name, calls: row.beforeDomContentLoaded })),
        domMutations: probe.mutations.loading,
      },

      // 3 — hydration, lazy loading, and everything else that waited for the DOM.
      afterDomContentLoaded: {
        requests: startedAfterDcl.length,
        bytes: sum(startedAfterDcl, 'bytes'),
        byType: countBy(startedAfterDcl, 'type'),
        apiCalls: used(probe.apis)
          .filter((row) => row.afterDomContentLoaded + row.afterLoad > 0)
          .map((row) => ({ name: row.name, calls: row.afterDomContentLoaded + row.afterLoad })),
        domMutations: probe.mutations.interactive + probe.mutations.complete,
        lateStyling: dynamicStyling
          .filter((row) => row.afterDomContentLoaded + row.afterLoad > 0)
          .map((row) => ({ name: row.name, calls: row.afterDomContentLoaded + row.afterLoad })),
      },

      // 4 — every asset, in the order the browser asked for it.
      assets: {
        total: assets.length,
        bytes: sum(assets, 'bytes'),
        byType: countBy(assets, 'type'),
        failed: assets.filter((asset) => asset.failed).map((asset) => ({ url: asset.url, error: asset.failed })),
        order: assets
          .sort((a, b) => a.startedAt - b.startedAt)
          .map((asset) => ({
            at: at(asset.startedAt),
            type: asset.type,
            url: asset.url.length > 160 ? `${asset.url.slice(0, 160)}…` : asset.url,
            status: asset.status ?? null,
            bytes: asset.bytes,
            mimeType: asset.mimeType ?? null,
            protocol: asset.protocol ?? null,
            initiator: asset.initiator,
            initiatorUrl: asset.initiatorUrl,
            fromCache: Boolean(asset.fromCache),
            redirects: asset.redirects,
            phase: before(asset.startedAt)(domContentLoaded) ? 'before-domcontentloaded' : 'after-domcontentloaded',
          })),
        authoredStylesheets: harvest.assets.stylesheets,
        authoredScripts: harvest.assets.scripts,
      },

      // 5 — which browser APIs the page actually reached for, and when.
      browserApis: {
        called: used(probe.apis),
        canvasContexts: used(probe.contexts).map((row) => ({ type: row.name, calls: row.total })),
        eventListeners: used(probe.listeners),
      },

      // 6 — how the DOM was rewritten after the parser finished with it.
      domMutations: {
        byPhase: probe.mutations,
        textEdits: probe.textEdits,
        elementsAdded: used(probe.addedTags),
        elementsRemoved: used(probe.removedTags),
        attributesChanged: used(probe.attributes),
        authoredScripts: harvest.assets.scripts.length,
        liveElements: harvest.layout.elements,
        maxDepth: harvest.layout.maxDepth,
      },

      // 7 — the split the question turns on: CSS on its own, or JavaScript driving it.
      styling: {
        static: {
          stylesheets: sheets.length,
          truncated: collected.headers.length > MAX_STYLESHEETS,
          unreadable: sheets.filter((sheet) => sheet.unreadable).length,
          bytes: sum(sheets, 'bytes'),
          declarationBlocks: staticDeclarations,
          customProperties: sum(sheets, 'customProperties'),
          varUsages: sum(sheets, 'varUsages'),
          mediaQueries: sum(sheets, 'mediaQueries'),
          containerQueries: sum(sheets, 'containerQueries'),
          keyframes: sum(sheets, 'keyframes'),
          transitions: sum(sheets, 'transitions'),
          animations: sum(sheets, 'animations'),
          hasSelector: sum(sheets, 'hasSelector'),
          layers: sum(sheets, 'layers'),
          fontFaces: sum(sheets, 'fontFaces'),
          important: sum(sheets, 'important'),
          declaredTokens: declared.length,
          respectsReducedMotion: sum(sheets, 'reducedMotion') > 0,
          respectsColorScheme: sum(sheets, 'colorScheme') > 0,
          sheets,
        },
        dynamic: {
          operations: dynamicStyling,
          total: sum(dynamicStyling, 'total'),
          keyframeAnimatedElements: harvest.layout.keyframeAnimated,
          transformedElements: harvest.layout.transformed,
          filteredElements: harvest.layout.filtered,
        },
        verdict: verdict(staticDeclarations, sum(dynamicStyling, 'total')),
      },

      // 8 — the run itself, start to finish.
      runtime: {
        trace: probe.timeline,
        listenerTypes: used(probe.listeners).length,
        topListeners: used(probe.listeners).slice(0, 12),
        layout: harvest.layout,
        exceptions: collected.exceptions,
        // The probe records its own installation failures and the page's thrown
        // errors in one list; conflating them in the report would blame the tool
        // for the site's bugs.
        instrumentationErrors: probe.errors.filter((entry) => entry.startsWith('instrument ')),
        pageErrors: probe.errors.filter((entry) => !entry.startsWith('instrument ')),
      },

      stack: harvest.stack,
      links: harvest.links,
      clone: cloned && {
        ...cloned,
        attachShadowCalls: probe.apis.attachShadow?.total ?? 0,
        revealed,
        preservedBuffers: probe.preservedBuffers ?? 0,
        slices: sliced ? { found: detected.slices.length, written: sliced.length } : null,
        // Carried for the crawl's final pass, not for the report.
        replacements: undefined,
      },
      sheetTexts: clone?.slices ? sheetTexts : undefined,
      shellCss: detected?.shell?.css,
      cloneReplacements: cloned?.replacements,
      direction: toDirection(harvest.design, { url: harvest.document.url, title: harvest.document.title }),
      screenshot: shot,
    };
  } finally {
    await session.close();
  }
}

function countBy(rows, key) {
  const totals = {};
  for (const row of rows) totals[row[key]] = (totals[row[key]] ?? 0) + 1;
  return Object.fromEntries(Object.entries(totals).sort((a, b) => b[1] - a[1]));
}

/**
 * Where a page's appearance is decided.
 *
 * Stylesheet declaration blocks are counted against runtime style writes. A
 * marketing page lands near "css"; an animation-driven one lands near
 * "javascript"; a component library with a theme switcher lands between them.
 */
function verdict(staticBlocks, dynamicWrites) {
  const total = staticBlocks + dynamicWrites;
  if (total === 0) return { source: 'unstyled', dynamicShare: 0 };
  const share = dynamicWrites / total;
  const source = share < 0.05 ? 'css' : share < 0.3 ? 'css-led' : share < 0.7 ? 'mixed' : 'javascript';
  return { source, dynamicShare: Number(share.toFixed(3)), staticBlocks, dynamicWrites };
}
