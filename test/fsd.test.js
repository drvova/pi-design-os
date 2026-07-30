import assert from 'node:assert/strict';
import { readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { chromePath } from '../src/cdp.js';
import { LAYOUTS, routePath } from '../src/clone.js';
import { cloneSite } from '../src/crawl.js';
import { markerToDir, splitAppStyles } from '../src/slices.js';

test('every route is a slice of the pages layer', () => {
  assert.equal(routePath('https://x.com/', 'fsd'), 'pages/home/ui/index.html');
  assert.equal(routePath('https://x.com/ui/developing-taste', 'fsd'), 'pages/ui-developing-taste/ui/index.html');
  // Slices do not nest within a layer, so a nested route flattens to one name.
  assert.equal(routePath('https://x.com/a/b/c', 'fsd'), 'pages/a-b-c/ui/index.html');
  assert.equal(routePath('https://x.com/', 'flat'), 'index.html');
});

test('assets are filed by what they are, under shared', () => {
  const root = (asset) => LAYOUTS.fsd.assetRoot(asset);
  assert.equal(root({ type: 'Font' }), 'shared/fonts');
  assert.equal(root({ type: 'Image' }), 'shared/images');
  assert.equal(root({ type: 'Stylesheet' }), 'shared/vendor');
  assert.equal(root({ type: 'Script' }), 'shared/vendor');
  // A favicon arrives typed Other; its mime is what says it is an image.
  assert.equal(root({ type: 'Other', mimeType: 'image/x-icon' }), 'shared/images');
  assert.equal(LAYOUTS.flat.assetRoot({ type: 'Font' }), 'assets');
});

test('shared holds segments directly, every other layer holds slices', () => {
  // The specification: Shared has no business domains, so it has no slices.
  assert.equal(markerToDir('shared/button'), 'shared/ui/button');
  assert.equal(markerToDir('widgets/site-header'), 'widgets/site-header');
  assert.equal(markerToDir('entities/post-card'), 'entities/post-card');
});

test('app styles are lifted out of the site stylesheets', () => {
  const { fonts, tokens, globals } = splitAppStyles([
    '@font-face{font-family:Demo;src:url(/d.woff2)}',
    ':root{--brand:#533afd;--gap:12px}',
    '*,::before{box-sizing:border-box}',
    'body{margin:0}',
    '.card{border-radius:12px}',
  ]);

  assert.equal(fonts.length, 1);
  assert.equal(tokens.length, 1);
  assert.equal(globals.length, 2, 'the universal rule and body, not the card');
  assert.ok(globals.every((rule) => !rule.includes('.card')));
});

test('a slice carries only the css that matched it', async (t) => {
  try {
    chromePath();
  } catch {
    t.skip('no Chrome or Chromium on this machine');
    return;
  }

  // The reset matches every node, the utility matches many, and the card rules
  // match only the card. A slice must end up with the last of those.
  const css = [
    ':root{--brand:#533afd}',
    '@font-face{font-family:Demo;src:url(/d.woff2) format("woff2")}',
    '*,::before,::after{box-sizing:border-box}',
    'body{margin:0;background:#101018;color:#eee;font-family:Demo,sans-serif}',
    '.flex{display:flex}.items-center{align-items:center}.mb-32{margin-bottom:8rem}',
    '.PostCard_root__c3d4{border-radius:12px;padding:16px}',
    '.PostCard_title__e5f6{color:var(--brand)}',
    '@media (min-width:40rem){.PostCard_root__c3d4{padding:24px}}',
    'button{background:var(--brand);border-radius:8px}',
  ].join('');

  const card = (n) =>
    `<article class="PostCard_root__c3d4"><h2 class="PostCard_title__e5f6">Item ${n}</h2><p>Body</p><a href="/two">More</a></article>`;
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/s.css"></head><body>
    <header class="mb-32 flex items-center"><h1>Title</h1><nav aria-label="Primary"><a href="/">Home</a></nav></header>
    <main>${card(1)}${card(2)}${card(3)}</main>
    <form id="subscribe"><label for="e">Email</label><input id="e" type="email"><button aria-label="Join the list">Go</button></form>
    </body></html>`;

  const pages = { '/': page, '/two': page };
  const origin = createServer((request, response) => {
    if (request.url === '/s.css') {
      response.writeHead(200, { 'content-type': 'text/css' });
      response.end(css);
      return;
    }
    if (request.url === '/d.woff2') {
      response.writeHead(200, { 'content-type': 'font/woff2' });
      response.end(Buffer.from('wOF2'));
      return;
    }
    const body = pages[request.url];
    response.writeHead(body ? 200 : 404, { 'content-type': 'text/html' });
    response.end(body ?? 'not found');
  });
  await new Promise((ready) => origin.listen(0, '127.0.0.1', ready));

  const url = `http://127.0.0.1:${origin.address().port}/`;
  const dir = join(tmpdir(), `design-os-fsd-test-${process.pid}`);

  try {
    const site = await cloneSite({ url, dir, routes: 2, wait: 4000, layout: 'fsd', verify: false });
    const find = (needle) => site.slices.find((slice) => slice.dir.includes(needle));

    // Named from the author's own CSS-module name, not from a utility class.
    const postCard = find('post-card');
    assert.ok(postCard, `no post-card slice in ${site.slices.map((s) => s.dir).join(', ')}`);
    assert.equal(postCard.layer, 'entities');
    assert.equal(postCard.namedBy, 'class');
    assert.equal(postCard.instances, 3);

    // The header carries utility classes only, so it must fall back to its tag
    // rather than becoming widgets/mb-32.
    const header = find('site-header');
    assert.ok(header, 'the header must be a widget');
    assert.equal(header.namedBy, 'tag');

    // An id names the instance; the tag says what it is.
    assert.ok(find('subscribe-form'), 'form#subscribe should become subscribe-form');
    // A primitive is named for what it is for, never for how it is styled.
    assert.ok(find('shared/ui/join-the-list-button'), 'a labelled control keeps its label');

    const styles = await readFile(join(dir, postCard.dir, 'ui', 'styles.css'), 'utf8');
    assert.match(styles, /PostCard_root__c3d4/);
    assert.match(styles, /@media \(min-width: ?40rem\)/, 'a conditional rule keeps its condition');
    assert.doesNotMatch(styles, /box-sizing/, 'the universal reset belongs to the app layer');
    assert.doesNotMatch(styles, /margin-bottom:\s*8rem/, 'a rule that never matched must not appear');

    // Layer files, and the entry pointing into pages.
    const entry = await readFile(join(dir, 'index.html'), 'utf8');
    assert.match(entry, /url=\.\/pages\/home\/ui\/index\.html/);
    assert.match(await readFile(join(dir, 'app', 'styles', 'tokens.css'), 'utf8'), /--brand/);
    assert.match(await readFile(join(dir, 'app', 'styles', 'fonts.css'), 'utf8'), /@font-face/);

    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.layout, 'fsd');
    assert.equal(manifest.routes.length, 2);
    assert.equal(manifest.slices.length, site.slices.length);

    const readme = await readFile(join(dir, 'README.md'), 'utf8');
    assert.match(readme, /Feature-Sliced Design/);
    assert.match(readme, /post-card/);

    // Every slice folder is complete, and no two share a directory.
    const directories = site.slices.map((slice) => slice.dir);
    assert.equal(new Set(directories).size, directories.length, 'two slices must never share a folder');
    for (const slice of site.slices) {
      const files = await readdir(join(dir, slice.dir, 'ui'));
      assert.deepEqual(files.sort(), ['preview.html', 'styles.css', 'ui.html']);
    }

    // A slice appearing on both routes is written once and records both.
    assert.ok(
      site.slices.some((slice) => slice.routes.length === 2),
      'a header on every route should be one folder, not one per route',
    );
  } finally {
    origin.close();
    await rm(dir, { recursive: true, force: true });
  }
});
