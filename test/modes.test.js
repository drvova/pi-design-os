import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { chromePath } from '../src/cdp.js';
import { inspectPage } from '../src/inspect.js';

/** Respects the media query, so emulation alone is enough. */
const BY_MEDIA = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
  :root { --surface: #fdfdfc; --ink: #101018 }
  @media (prefers-color-scheme: dark) { :root { --surface: #080a0c; --ink: #f4f1d2 } }
  html { background: var(--surface) } body { color: var(--ink); margin: 0; padding: 20px; font-family: sans-serif }
  .card { border-radius: 12px; padding: 16px }
</style></head><body><main><h1>Media</h1><div class="card">a</div><div class="card">b</div></main></body></html>`;

/** Ignores the media query and keys off its own attribute, the way lawsofux.com does. */
const BY_CONTROL = `<!doctype html><html lang="en" data-color-mode="light"><head><meta charset="utf-8"><style>
  :root[data-color-mode="light"] { --surface: #fdfdfc; --ink: #101018 }
  :root[data-color-mode="dark"] { --surface: #060f13; --ink: #f4f1d2 }
  html { background: var(--surface) } body { color: var(--ink); margin: 0; padding: 20px; font-family: sans-serif }
  .card { border-radius: 12px; padding: 16px }
</style></head><body>
  <button type="button" aria-label="Dark Mode">theme</button>
  <main><h1>Control</h1><div class="card">a</div><div class="card">b</div></main>
  <script>
    document.querySelector('button').addEventListener('click', () => {
      const root = document.documentElement;
      root.setAttribute('data-color-mode', root.getAttribute('data-color-mode') === 'dark' ? 'light' : 'dark');
    });
  <\/script></body></html>`;

/** Has one appearance and no way to change it. */
const NO_VARIANT = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
  html { background: #fdfdfc } body { color: #101018; margin: 0; padding: 20px; font-family: sans-serif }
  .card { border-radius: 12px; padding: 16px }
</style></head><body><main><h1>Fixed</h1><div class="card">a</div><div class="card">b</div></main></body></html>`;

async function serveOnce(page) {
  const origin = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(page);
  });
  await new Promise((ready) => origin.listen(0, '127.0.0.1', ready));
  return { url: `http://127.0.0.1:${origin.address().port}/`, close: () => origin.close() };
}

test('a colour scheme is reached however the page implements it', async (t) => {
  try {
    chromePath();
  } catch {
    t.skip('no Chrome or Chromium on this machine');
    return;
  }

  // Emulating the media feature is enough here, and must be what is used: it
  // touches nothing on the page.
  const media = await serveOnce(BY_MEDIA);
  try {
    const report = await inspectPage({ url: media.url, wait: 4000, modes: ['dark'] });
    const [variant] = report.variants;
    assert.equal(variant.changed, true);
    assert.equal(variant.activatedBy, 'prefers-color-scheme');
    assert.equal(variant.direction.axes.polarity, 'Dark');
    assert.equal(report.direction.axes.polarity, 'Light', 'the base reading stays light');
    assert.notEqual(variant.direction.observed.surface.hex, report.direction.observed.surface.hex);
  } finally {
    media.close();
  }

  // This one reports the dark preference as matching and stays light regardless,
  // so the page's own control has to be used. That is the common case.
  const control = await serveOnce(BY_CONTROL);
  try {
    const report = await inspectPage({ url: control.url, wait: 4000, modes: ['dark'] });
    const [variant] = report.variants;
    assert.equal(variant.changed, true);
    assert.match(variant.activatedBy, /^control: /, `expected the page's own control, got ${variant.activatedBy}`);
    assert.match(variant.root, /data-color-mode=dark/);
    assert.equal(variant.direction.axes.polarity, 'Dark');
    assert.equal(variant.direction.observed.surface.hex, '#060f13');
  } finally {
    control.close();
  }

  // Asking for something a page does not have must say so, not hand back the
  // same design twice under a different name.
  const fixed = await serveOnce(NO_VARIANT);
  try {
    const report = await inspectPage({ url: fixed.url, wait: 4000, modes: ['dark'] });
    const [variant] = report.variants;
    assert.equal(variant.changed, false);
    assert.equal(variant.direction, undefined);
    assert.match(variant.reason, /no such variant/);
  } finally {
    fixed.close();
  }
});

test('the copy is taken in the state the page arrived in, not in a variant', async (t) => {
  try {
    chromePath();
  } catch {
    t.skip('no Chrome or Chromium on this machine');
    return;
  }

  const control = await serveOnce(BY_CONTROL);
  const dir = join(tmpdir(), `design-os-modes-${process.pid}`);

  try {
    const report = await inspectPage({
      url: control.url,
      wait: 4000,
      modes: ['dark'],
      clone: { dir, slices: { ledger: new Map(), routeMarker: 'index.html' }, layout: 'fsd' },
    });

    assert.equal(report.variants[0].changed, true, 'the variant was still read');

    // Reading a variant means changing the page for good — a clicked toggle does
    // not come back when the emulated media query is cleared. So it has to happen
    // after the copy, and the copy has to still be light.
    // The html tag specifically: the fixture's own stylesheet mentions the dark
    // selector, so searching the whole document proves nothing.
    const html = await readFile(join(dir, 'index.html'), 'utf8');
    const tag = /<html[^>]*>/.exec(html)[0];
    assert.match(tag, /data-color-mode="light"/, 'the copy must not come out dark');
    assert.doesNotMatch(tag, /dark/);

    const { writeVariantTokens } = await import('../src/slices.js');
    const written = await writeVariantTokens(dir, report.variants);
    assert.deepEqual(
      written.map((entry) => entry.selector),
      [':root[data-color-mode="dark"]'],
      'the selector comes from what the page set, not from an assumption',
    );

    const tokens = await readFile(join(dir, 'app', 'styles', 'tokens.dark.css'), 'utf8');
    assert.match(tokens, /:root\[data-color-mode="dark"\]/);
    assert.match(tokens, /reached by control:/);
  } finally {
    control.close();
    await rm(dir, { recursive: true, force: true });
  }
});
