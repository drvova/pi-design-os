import assert from 'node:assert/strict';
import { readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import test from 'node:test';

import { chromePath } from '../src/cdp.js';
import { compareDesign, serveDirectory } from '../src/clone.js';
import { inspectPage } from '../src/inspect.js';

/** Every file under a directory, as paths relative to it. */
async function walk(root, base = root) {
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(path, base)));
    else found.push(relative(base, path));
  }
  return found;
}

test('a served directory refuses to hand out anything above its root', async () => {
  const served = await serveDirectory(new URL('.', import.meta.url).pathname);
  try {
    const escape = await fetch(new URL('/../package.json', served.url));
    assert.equal(escape.status, 404, 'a normalised traversal must not resolve to a real file');

    const encoded = await fetch(`${served.url}..%2F..%2Fpackage.json`);
    assert.ok(encoded.status === 403 || encoded.status === 404, `encoded traversal leaked: ${encoded.status}`);

    const allowed = await fetch(new URL('clone.test.js', served.url));
    assert.equal(allowed.status, 200);
  } finally {
    await served.close();
  }
});

test('compareDesign scores identity as one and a divergence below it', () => {
  const observed = {
    surface: { hex: '#ffffff', l: 1 },
    accent: { hex: '#533afd', l: 0.5, c: 0.2, h: 270 },
    palette: [{ hex: '#ffffff' }, { hex: '#533afd' }],
    families: ['Inter'],
    typeScale: { ratio: 1.25, sizes: ['16px'] },
    radii: ['8px'],
    spacing: ['12px'],
  };
  const layout = { elements: 100, maxDepth: 8, grids: 2, flexes: 10 };
  const report = { direction: { observed, axes: { polarity: 'Light' } }, runtime: { layout } };

  assert.equal(compareDesign(report, report).score, 1);

  const drifted = {
    direction: {
      observed: { ...observed, surface: { hex: '#000000', l: 0 }, families: ['Helvetica'] },
      axes: { polarity: 'Dark' },
    },
    runtime: { layout: { ...layout, elements: 50 } },
  };
  const scored = compareDesign(report, drifted);
  assert.ok(scored.score < 0.8, `expected a low score, got ${scored.score}`);
  assert.deepEqual(scored.checks.surface, 0);
  assert.ok(scored.weakest.some((entry) => entry.startsWith('surface')));
});

test('a clone carries CSS that only ever existed in the CSSOM', async (t) => {
  try {
    chromePath();
  } catch {
    t.skip('no Chrome or Chromium on this machine');
    return;
  }

  // The rule below is added with insertRule and never written to the style
  // element's text. outerHTML cannot see it; a clone without materialisation
  // renders this page unstyled, which is exactly how CSS-in-JS behaves.
  const page = `<!doctype html><html lang="en" class="theme-dark" data-scheme="night"><head>
    <link rel="stylesheet" href="/base.css?v=2">
    <link rel="preload" as="image" href="/dot.svg">
    <script src="/inject.js"></script>
  </head><body><main><h1>Cloned</h1><img src="/dot.svg" alt="dot"><input id="f">
    <iframe src="http://127.0.0.1:1/widget" title="unreachable"></iframe></main></body></html>`;

  const base = `body { margin: 0; padding: 24px; font-family: Inter, sans-serif; }
    h1 { font-size: 32px; } main { display: flex; }`;

  const inject = `(function () {
      const style = document.createElement('style');
      document.head.appendChild(style);
      style.sheet.insertRule('body { background: rgb(16, 16, 24); color: rgb(240, 240, 250); }', 0);
      style.sheet.insertRule('h1 { border-radius: 12px; }', 1);
      const constructed = new CSSStyleSheet();
      constructed.replaceSync('main { gap: 16px; }');
      document.adoptedStyleSheets = [constructed];
      // The script is parser-blocking in head, so the field does not exist yet.
      document.addEventListener('DOMContentLoaded', () => {
        document.getElementById('f').value = 'typed by script';
      });
    })();`;

  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><circle cx="4" cy="4" r="4" fill="#533afd"/></svg>';
  const bodies = {
    '/': [page, 'text/html'],
    '/base.css?v=2': [base, 'text/css'],
    '/inject.js': [inject, 'text/javascript'],
    '/dot.svg': [svg, 'image/svg+xml'],
  };

  const server = createServer((request, response) => {
    const entry = bodies[request.url] ?? ['missing', 'text/plain'];
    response.writeHead(bodies[request.url] ? 200 : 404, { 'content-type': entry[1] });
    response.end(entry[0]);
  });
  await new Promise((resolved) => server.listen(0, '127.0.0.1', resolved));

  const url = `http://127.0.0.1:${server.address().port}/`;
  const dir = join(tmpdir(), `design-os-clone-test-${process.pid}`);

  try {
    const report = await inspectPage({ url, wait: 6000, clone: { dir } });
    const clone = report.clone;

    assert.equal(clone.materialised.inlineSheets, 1, 'the injected sheet must be written back');
    assert.equal(clone.materialised.adoptedSheets, 1, 'a constructed sheet lives outside document.styleSheets');
    assert.equal(clone.materialised.rules, 3);
    assert.deepEqual(report.runtime.exceptions, [], 'a throwing fixture would silently skip later assertions');
    assert.equal(clone.materialised.fields, 1, 'a value set by script is a property, not an attribute');
    // A frame whose body cannot be read must not be left pointing at the origin.
    assert.equal(clone.framesEmptied, 1);

    const html = await readFile(join(dir, 'index.html'), 'utf8');
    // Theme and font-variable classes live on <html>; a clone that loses the
    // element loses every token scoped to those classes.
    assert.match(html, /<html lang="en" class="theme-dark" data-scheme="night">/);
    assert.match(html, /<\/html>\s*$/);
    assert.match(html, /background: rgb\(16, 16, 24\)/, 'the insertRule rule must survive into the clone');
    assert.match(html, /main \{ gap: 16px/, 'the adopted sheet must survive into the clone');
    assert.match(html, /value="typed by script"/);

    // References point at local files, the origin is gone, hints are stripped.
    assert.ok(!html.includes(url), 'no reference may still point at the original origin');
    assert.match(html, /\.\/assets\/127\.0\.0\.1[^"']*\/base\.[^"']*\.css/, 'the query string folds into the filename');
    assert.doesNotMatch(html, /rel="preload"/, 'a preload would 404 against the clone');
    assert.match(html, /<script type="text\/plain" data-design-os="disabled"/);
    assert.match(html, /<iframe[^>]*data-design-os-src="http:\/\/127\.0\.0\.1:1\/widget"/);
    assert.doesNotMatch(html, /<iframe[^>]*\ssrc=/, 'an emptied frame keeps its address as data, not as src');

    const files = await walk(dir);
    assert.ok(files.includes('index.html'));
    assert.equal(files.filter((file) => file.endsWith('.css')).length, 1);
    assert.equal(files.filter((file) => file.endsWith('.svg')).length, 1);
    assert.equal(files.filter((file) => file.endsWith('.js')).length, 1, 'scripts are saved even when disabled');
    for (const file of files) {
      assert.ok(resolve(dir, file).startsWith(resolve(dir) + sep), `${file} escapes the output directory`);
    }

    // The clone is only a clone if it holds up when loaded.
    const served = await serveDirectory(dir);
    try {
      const replica = await inspectPage({ url: served.url, wait: 5000 });
      assert.equal(replica.capture.failed, 0, 'a rewritten reference that 404s is a broken clone');
      assert.equal(replica.capture.degraded, false);
      assert.equal(replica.direction.axes.polarity, 'Dark', 'the injected background must still apply');

      const fidelity = compareDesign(report, replica);
      assert.ok(fidelity.score >= 0.9, `fidelity ${fidelity.score}: ${fidelity.weakest.join(', ')}`);
      assert.equal(fidelity.checks.surface, 1);
      assert.equal(fidelity.checks.families, 1);
    } finally {
      await served.close();
    }
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
