import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { chromePath } from '../src/cdp.js';
import { toDirection } from '../src/extract.js';
import { authored, cssStats, inspectPage } from '../src/inspect.js';
import { fromRgb, toHex } from '../src/oklch.js';

test('sRGB survives the round trip through OKLCH without drift', () => {
  for (const [r, g, b] of [[255, 255, 255], [0, 0, 0], [255, 0, 0], [0, 128, 255], [34, 197, 94], [83, 58, 253]]) {
    const { l, c, h } = fromRgb(r, g, b);
    const hex = toHex(l, c, h);
    const back = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
    assert.deepEqual(back, [r, g, b], `${hex} did not return to rgb(${r}, ${g}, ${b})`);
  }
});

test('authored head separates render-blocking assets from deferred ones', () => {
  const parsed = authored(`<html><head>
    <meta charset="utf-8">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link rel="preload" as="font" href="/f.woff2">
    <link rel="stylesheet" href="/app.css">
    <link rel="stylesheet" href="/print.css" media="print">
    <script src="/blocking.js"></script>
    <script src="/deferred.js" defer></script>
    <script type="module" src="/app.mjs"></script>
    <script>window.inline = 1;</script>
    <style>body{color:red}</style>
  </head><body></body></html>`);

  assert.deepEqual(parsed.hints.map((hint) => hint.rel), ['preconnect', 'preload']);
  assert.equal(parsed.hints[0].crossorigin, true);
  assert.equal(parsed.stylesheets.length, 2);
  assert.equal(parsed.renderBlockingStylesheets, 1, 'media="print" does not block rendering');
  assert.equal(parsed.scripts.length, 4);
  assert.equal(parsed.parserBlockingScripts, 1, 'only the bare external script halts the parser');
  assert.equal(parsed.scripts.at(-1).inlineBytes, 'window.inline = 1;'.length);
  assert.equal(parsed.inlineStyleBlocks, 1);
  assert.equal(parsed.meta.charset, 'utf-8');
});

test('cssStats counts the at-rules a design system is built from', () => {
  const stats = cssStats(`
    :root { --brand: #533afd; --gap: 8px; }
    @media (min-width: 40rem) { .a { color: var(--brand); } }
    @media (prefers-reduced-motion: reduce) { .a { transition: none; } }
    @keyframes spin { to { rotate: 360deg; } }
    .b:has(> img) { gap: var(--gap); transition: opacity 200ms; }
  `);

  assert.equal(stats.customProperties, 2);
  assert.equal(stats.varUsages, 2);
  assert.equal(stats.mediaQueries, 2);
  assert.equal(stats.keyframes, 1);
  assert.equal(stats.hasSelector, 1);
  assert.equal(stats.reducedMotion, 1);
  assert.ok(stats.blocks >= 6);
});

test('a dark, highly chromatic page becomes a dark vivid direction', () => {
  const direction = toDirection(
    {
      background: [{ value: '10,10,18', weight: 900 }],
      foreground: [{ value: '245,245,250', weight: 200 }],
      accents: [{ value: '83,58,253', weight: 300 }],
      families: [{ value: 'Sohne', weight: 100 }],
      sizes: [{ value: '16px', weight: 9 }, { value: '20px', weight: 4 }, { value: '25px', weight: 2 }],
      weights: [{ value: '400', weight: 9 }, { value: '700', weight: 3 }],
      leading: [{ value: '1.5', weight: 9 }],
      tracking: [],
      radii: [{ value: '16px', weight: 5 }],
      shadows: [],
      borders: [],
      spacing: [{ value: '13px', weight: 7 }],
      durations: [{ value: '0.32s', weight: 4 }],
      easings: [{ value: 'cubic-bezier(0.34, 1.56, 0.64, 1)', weight: 4 }],
      customProperties: { '--brand': '#533afd' },
    },
    { url: 'https://www.example.com/pricing', title: 'Example' },
  );

  assert.equal(direction.axes.polarity, 'Dark', 'a near-black surface is a dark direction');
  assert.equal(direction.axes.tone, 'Vivid');
  assert.equal(direction.axes.shape, 'Pill', 'a 16px radius is 1rem, the Pill step');
  assert.equal(direction.axes.motion, 'Springy', '320ms matches the springy step');
  assert.equal(direction.observed.accent.hex, '#533afd');
  assert.equal(direction.id, 'site-example-com', 'the www prefix is dropped from the id');
  assert.equal(direction.observed.typeScale.ratio, 1.25, 'the median step, not the first pair');
  // Snapping must not lose the reading it was snapped from.
  assert.equal(direction.observed.radii[0], '16px');
  assert.deepEqual(direction.observed.declaredTokens, { '--brand': '#533afd' });
  assert.match(direction.tokens['--ds-font-sans'], /^Sohne, ui-sans-serif/);
});

test('a whole pipeline is read off one page load', async (t) => {
  try {
    chromePath();
  } catch {
    t.skip('no Chrome or Chromium on this machine');
    return;
  }

  // Every phase the report claims to separate is represented exactly once here,
  // so a wrong bucket shows up as a wrong number rather than as a missing field.
  const page = `<!doctype html><html><head>
    <meta charset="utf-8">
    <link rel="preconnect" href="https://example.invalid">
    <link rel="stylesheet" href="/site.css">
    <script>
      window.__marks = { atParse: document.readyState };
      document.documentElement.style.setProperty('--set-during-parse', '1');
    </script>
    <script src="/late.js" defer></script>
  </head><body>
    <main><h1>Heading</h1><p>Body copy sits here.</p><button id="cta">Act</button></main>
  </body></html>`;

  const css = `:root { --brand: #533afd; --radius: 12px; }
    body { background: #101018; color: #f5f5fa; font-family: Inter, sans-serif; margin: 0; padding: 24px; }
    h1 { font-size: 32px; } p { font-size: 16px; }
    #cta { background: var(--brand); color: #ffffff; border-radius: var(--radius); padding: 12px; transition: opacity 320ms; }
    @media (prefers-reduced-motion: reduce) { #cta { transition: none; } }`;

  const late = `document.addEventListener('DOMContentLoaded', () => {
      new IntersectionObserver(() => {}).observe(document.body);
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.style.setProperty('color', 'rgb(255, 0, 128)');
      document.querySelector('main').appendChild(badge);
      document.getElementById('cta').classList.add('ready');
      requestAnimationFrame(() => document.body.setAttribute('data-ready', 'true'));
    });`;

  const bodies = { '/': [page, 'text/html'], '/site.css': [css, 'text/css'], '/late.js': [late, 'text/javascript'] };
  const server = createServer((request, response) => {
    const [body, type] = bodies[request.url] ?? ['not found', 'text/plain'];
    response.writeHead(bodies[request.url] ? 200 : 404, { 'content-type': type });
    response.end(body);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;

  try {
    const report = await inspectPage({ url, wait: 8000 });

    // 0 — the capture itself, before trusting anything it says.
    assert.equal(report.capture.degraded, false);
    assert.equal(report.capture.failed, 0);
    assert.equal(report.capture.reason, null);

    // 1 — what the parser was handed.
    assert.equal(report.preDom.hints[0].rel, 'preconnect');
    assert.equal(report.preDom.renderBlockingStylesheets, 1);
    assert.equal(report.preDom.parserBlockingScripts, 0, 'the only external script is deferred');

    // 2 — the inline script ran while the document was still parsing.
    assert.ok(report.beforeDomContentLoaded.stylesheetsFetched >= 1);
    const parseWrite = report.styling.dynamic.operations.find((row) => row.name === 'style.setProperty');
    assert.ok(parseWrite.beforeDomContentLoaded >= 1, 'the parse-time setProperty must land in the loading phase');

    // 3 — the deferred script only ran once the DOM existed.
    assert.ok(report.afterDomContentLoaded.domMutations >= 2);
    assert.ok(report.afterDomContentLoaded.apiCalls.some((row) => row.name === 'IntersectionObserver'));

    // 4 — every asset, typed and ordered.
    assert.equal(report.assets.byType.Document, 1);
    assert.equal(report.assets.byType.Stylesheet, 1);
    assert.equal(report.assets.byType.Script, 1);
    assert.equal(report.assets.order[0].type, 'Document', 'the document is always requested first');
    assert.equal(report.assets.failed.length, 0);

    // 5 — APIs, with the phase and the moment of first use.
    const observer = report.browserApis.called.find((row) => row.name === 'IntersectionObserver');
    assert.equal(observer.total, 1);
    assert.ok(observer.firstAt > 0);
    assert.ok(report.browserApis.eventListeners.some((row) => row.name === 'DOMContentLoaded'));

    // 6 — the DOM the parser built, then what script did to it.
    assert.ok(report.domMutations.byPhase.loading > 0, 'the parser itself mutates the document');
    assert.ok(report.domMutations.elementsAdded.some((row) => row.name === 'span'));
    assert.ok(report.domMutations.attributesChanged.some((row) => row.name === 'data-ready'));

    // 7 — static CSS against runtime writes.
    assert.equal(report.styling.static.respectsReducedMotion, true);
    assert.ok(report.styling.static.customProperties >= 2);
    assert.ok(report.styling.dynamic.total >= 3);
    assert.equal(report.styling.verdict.source, 'mixed', 'a small sheet plus live writes is neither pure');

    // 8 — the run, start to finish.
    assert.equal(report.runtime.trace[0].label, 'probe-installed');
    assert.equal(report.runtime.trace[0].phase, 'loading', 'instrumentation precedes the DOM');
    assert.deepEqual(report.runtime.instrumentationErrors, [], 'the probe must install cleanly');
    assert.deepEqual(report.runtime.pageErrors, []);
    assert.deepEqual(report.runtime.exceptions, []);
    assert.ok(report.timeline.domContentLoadedAt > 0);
    assert.ok(report.timeline.loadAt >= report.timeline.domContentLoadedAt);

    // The design read back off the rendered page.
    assert.equal(report.direction.axes.polarity, 'Dark');
    assert.equal(report.direction.observed.accent.hex, '#533afd');
    assert.equal(report.direction.observed.declaredTokens['--radius'], '12px');
    assert.equal(report.direction.observed.families[0], 'Inter');
  } finally {
    server.close();
  }
});
