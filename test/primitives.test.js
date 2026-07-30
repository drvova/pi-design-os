import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { chromePath } from '../src/cdp.js';
import { inspectPage } from '../src/inspect.js';

/**
 * A page whose appearance comes from APIs rather than from CSS.
 *
 * None of this survives serialization on its own: a canvas paints through a
 * context that is gone once scripts are disabled, `Element.animate` never
 * reaches the CSSOM, and anything below the fold is waiting for a viewport that
 * a headless capture never gives it.
 */
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
  body { background:#101018; color:#eee; margin:0; padding:20px; font-family:sans-serif }
  .spacer { height:2400px } .card { height:200px; background:#1a1a24; border-radius:12px }
</style></head><body>
  <canvas id="painted" width="200" height="100"></canvas>
  <canvas id="scene" width="200" height="100"></canvas>
  <canvas id="untouched" width="80" height="40"></canvas>
  <div id="moving" class="card">animated by script</div>
  <div class="spacer"></div>
  <img id="late" loading="lazy" src="/dot.svg" width="64" height="64">
  <div id="revealed" class="card">styled only once seen</div>
  <script>
    var flat = document.getElementById('painted').getContext('2d');
    flat.fillStyle = '#533afd'; flat.fillRect(0, 0, 200, 100);
    flat.fillStyle = '#ffffff'; flat.fillRect(20, 20, 60, 60);

    var gl = document.getElementById('scene').getContext('webgl');
    if (gl) { gl.clearColor(0.95, 0.2, 0.5, 1); gl.clear(gl.COLOR_BUFFER_BIT); }

    document.getElementById('moving').animate(
      [{ opacity: 0, transform: 'translateY(20px)' }, { opacity: 1, transform: 'translateY(0)' }],
      { duration: 600, easing: 'ease-out', fill: 'both', iterations: Infinity },
    );

    new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) entry.target.style.outline = '3px solid rgb(83, 58, 253)';
      });
    }).observe(document.getElementById('revealed'));
  <\/script>
</body></html>`;

const DOT = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="32" fill="#22c55e"/></svg>';

/** The canvas tag for one id, with its inlined frame decoded. */
function frameFor(html, id) {
  const tag = new RegExp(`<canvas[^>]*id="?${id}"?[^>]*>`).exec(html)?.[0] ?? '';
  const encoded = /base64,([A-Za-z0-9+/=]+)/.exec(tag)?.[1];
  if (!encoded) return { tag, png: null };

  const raw = Buffer.from(encoded, 'base64');
  return {
    tag,
    png: { width: raw.readUInt32BE(16), height: raw.readUInt32BE(20), bytes: raw.length, body: raw.toString('base64') },
  };
}

test('what only an api could draw is carried into the clone', async (t) => {
  try {
    chromePath();
  } catch {
    t.skip('no Chrome or Chromium on this machine');
    return;
  }

  const origin = createServer((request, response) => {
    if (request.url === '/dot.svg') {
      response.writeHead(200, { 'content-type': 'image/svg+xml' });
      response.end(DOT);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(PAGE);
  });
  await new Promise((ready) => origin.listen(0, '127.0.0.1', ready));

  const url = `http://127.0.0.1:${origin.address().port}/`;
  const dir = join(tmpdir(), `design-os-primitives-${process.pid}`);

  try {
    const report = await inspectPage({ url, wait: 6000, clone: { dir } });
    const { materialised, revealed, preservedBuffers } = report.clone;
    const html = await readFile(join(dir, 'index.html'), 'utf8');

    // A webgl drawing buffer is cleared after compositing unless the context was
    // asked to keep it, and that can only be set when the context is created.
    assert.equal(preservedBuffers, 1, 'the webgl context must be created with preserveDrawingBuffer');

    // Two canvases were painted; the third never was and has nothing to keep.
    assert.equal(materialised.canvases, 2, 'only painted canvases carry a frame');
    const painted = frameFor(html, 'painted');
    const scene = frameFor(html, 'scene');
    assert.deepEqual(
      [painted.png?.width, painted.png?.height],
      [200, 100],
      'the frame keeps the canvas dimensions',
    );
    assert.ok(scene.png, 'a webgl scene reads back as pixels, not as an empty element');
    assert.notEqual(painted.png.body, scene.png.body, 'each canvas keeps its own frame');
    assert.equal(frameFor(html, 'untouched').png, null, 'a blank canvas would overwrite the stylesheet background');

    // Element.animate never reaches the CSSOM, so serialization loses it unless
    // it is rewritten as the rule it is equivalent to.
    assert.equal(materialised.animations, 1);
    assert.match(html, /@keyframes design-os-anim-0/);
    assert.match(html, /animation: design-os-anim-0 600ms ease-out 0ms infinite normal both/);
    assert.match(html, /data-design-os-anim="design-os-anim-0"/);
    assert.match(html, /translateY\(20px\)/, 'the keyframes keep their declarations');

    // Walking the page is what makes an observer below the fold ever fire.
    assert.ok(revealed.steps >= 2, `expected a walk, got ${JSON.stringify(revealed)}`);
    assert.ok(revealed.height > 2400);
    assert.match(
      /<div[^>]*id="?revealed"?[^>]*>/.exec(html)[0],
      /outline/,
      'an intersection observer below the fold must have fired before capture',
    );

    // The walk happens after measurement, so the report still describes the
    // page's own behaviour rather than the scrolling this tool did.
    assert.equal(report.capture.degraded, false);
    assert.deepEqual(report.runtime.instrumentationErrors, []);
  } finally {
    origin.close();
    await rm(dir, { recursive: true, force: true });
  }
});
