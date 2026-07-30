import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { chromePath } from '../src/cdp.js';
import { localise, routePath, serveDirectory } from '../src/clone.js';
import { cloneSite } from '../src/crawl.js';

test('a route becomes a directory, so nested paths cannot collide', () => {
  assert.equal(routePath('https://x.com/'), 'index.html');
  assert.equal(routePath('https://x.com/pricing'), 'pricing/index.html');
  assert.equal(routePath('https://x.com/docs/install'), 'docs/install/index.html');
  // /docs is a page and a parent at once; directory form gives each its own file.
  assert.notEqual(routePath('https://x.com/docs'), routePath('https://x.com/docs/install'));
  assert.equal(routePath('https://x.com/about.html'), 'about.html');
  assert.match(routePath('https://x.com/search?q=1'), /^search\/[\da-f]{8}\/index\.html$/);
  assert.equal(routePath('https://x.com/../etc/passwd'), 'etc/passwd/index.html');
});

test('one url that prefixes another is never spliced into it', () => {
  const replacements = [
    { url: 'https://x.com/docs', path: 'docs/index.html' },
    { url: 'https://x.com/docs/install', path: 'docs/install/index.html' },
    { url: 'https://x.com/a.css', path: 'assets/x.com/a.css' },
    { url: 'https://x.com/a.css.map', path: 'assets/x.com/a.css.map' },
  ];
  const html = '<a href="/docs">d</a><a href="/docs/install">i</a><link href="/a.css"><link href="/a.css.map">';
  const out = localise(html, 'index.html', 'https://x.com', replacements);

  assert.match(out, /href="\.\/docs\/index\.html"/);
  assert.match(out, /href="\.\/docs\/install\/index\.html"/);
  assert.match(out, /href="\.\/assets\/x\.com\/a\.css"/);
  assert.match(out, /href="\.\/assets\/x\.com\/a\.css\.map"/);
  // The substitution for the short url must not reappear inside the long one.
  assert.doesNotMatch(out, /index\.html\/install/, 'a shorter url was spliced into a longer one');
  assert.doesNotMatch(out, /a\.css"\.map|a\.css\.map\.map/);
});

test('a url reference is matched as a whole token, not as a substring', () => {
  const replacements = [
    { url: 'https://x.com/', path: 'index.html' },
    { url: 'https://x.com/docs', path: 'docs/index.html' },
  ];
  const rewrite = (html) => localise(html, 'index.html', 'https://x.com', replacements);

  // The entry url prefixes every absolute url on its own site.
  assert.equal(rewrite('<a href="https://x.com/plus?ref=home">'), '<a href="https://x.com/plus?ref=home">');
  assert.equal(rewrite('<a href="https://x.com/">'), '<a href="./index.html">');

  // A cloned route prefixes uncloned ones beneath it, with nothing longer to prefer.
  assert.equal(rewrite('<a href="/docs/installation">'), '<a href="/docs/installation">');
  assert.equal(rewrite('<a href="/docs">'), '<a href="./docs/index.html">');

  // A fragment or a query addresses the same document, so both follow it.
  assert.equal(rewrite('<a href="/docs#install">'), '<a href="./docs/index.html#install">');
  assert.equal(rewrite('<a href="/docs?tab=cli">'), '<a href="./docs/index.html?tab=cli">');

  // url() closes with a paren and srcset separates on whitespace.
  assert.equal(rewrite('@import url(/docs);'), '@import url(./docs/index.html);');
  assert.equal(rewrite('<img srcset="/docs 2x">'), '<img srcset="./docs/index.html 2x">');
});

test('a reference is matched at both of its ends', () => {
  const replacements = [{ url: 'https://x.com/_app/a.css', path: 'shared/vendor/x.com/_app/a.css' }];
  const local = 'shared/vendor/x.com/_app/a.css';

  // Every spelling of the same file resolves to the same place. A page at the
  // root writes `./_app/a.css`; guarding only the end of a match rewrote it one
  // character in and produced a path beginning `.../`, which resolves nowhere.
  for (const [markup, why] of [
    ['<link href="./_app/a.css">', 'document-relative'],
    ['<link href="_app/a.css">', 'bare relative'],
    ['<link href="/_app/a.css">', 'root-relative'],
    ['<link href="https://x.com/_app/a.css">', 'absolute'],
    ['<link href="//x.com/_app/a.css">', 'protocol-relative'],
  ]) {
    const out = localise(markup, 'pages/home/ui/index.html', 'https://x.com/', replacements);
    assert.equal(out, `<link href="../../../${local}">`, why);
    assert.doesNotMatch(out, /\.\.\.\//, `${why} produced a path with three leading dots`);
  }

  // A nested page resolves relative references from its own directory, and for
  // anything above it that means a `../` form.
  const nested = localise(
    '<link href="../_app/a.css">',
    'pages/docs-intro/ui/index.html',
    'https://x.com/docs/intro',
    replacements,
  );
  assert.equal(nested, `<link href="../../../${local}">`);

  // A longer path that merely starts with a known one is still left alone.
  const longer = localise('<link href="/_app/a.css.map">', 'pages/home/ui/index.html', 'https://x.com/', replacements);
  assert.equal(longer, '<link href="/_app/a.css.map">');
});

test('rewriting is a single pass, so a substitution is never re-substituted', () => {
  // The local path deliberately contains the url being replaced.
  const replacements = [{ url: 'https://x.com/site', path: 'site/index.html' }];
  const out = localise('<a href="/site">s</a>', 'index.html', 'https://x.com', replacements);
  assert.equal(out, '<a href="./site/index.html">s</a>');
});

test('a crawl follows the site, links the routes, and scores each one', async (t) => {
  try {
    chromePath();
  } catch {
    t.skip('no Chrome or Chromium on this machine');
    return;
  }

  const css = 'body{background:#101018;color:#eee;font-family:Inter,sans-serif;margin:0;padding:24px}.card{border-radius:12px}';
  const nav =
    '<nav><a href="/">Home</a> <a href="/pricing">Pricing</a> <a href="/docs">Docs</a>' +
    '<a href="/docs/install">Install</a> <a href="https://example.com/away">Off site</a>' +
    '<a href="/paper.pdf">Paper</a> <a href="/docs#anchor">Fragment</a></nav>';
  const page = (title) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/s.css">` +
    `</head><body>${nav}<main class="card"><h1>${title}</h1></main></body></html>`;

  const pages = { '/': page('Home'), '/pricing': page('Pricing'), '/docs': page('Docs'), '/docs/install': page('Install') };
  let cssRequests = 0;

  const origin = createServer((request, response) => {
    if (request.url === '/s.css') {
      cssRequests += 1;
      response.writeHead(200, { 'content-type': 'text/css' });
      response.end(css);
      return;
    }
    const body = pages[request.url];
    response.writeHead(body ? 200 : 404, { 'content-type': 'text/html' });
    response.end(body ?? 'not found');
  });
  await new Promise((ready) => origin.listen(0, '127.0.0.1', ready));

  const url = `http://127.0.0.1:${origin.address().port}/`;
  const dir = join(tmpdir(), `design-os-crawl-test-${process.pid}`);

  try {
    const site = await cloneSite({ url, dir, routes: 4, wait: 4000 });

    assert.equal(site.cloned, 4);
    assert.deepEqual(
      site.routes.map((route) => route.path).sort(),
      ['docs/index.html', 'docs/install/index.html', 'index.html', 'pricing/index.html'],
    );

    // A pdf is not a page and a fragment is the page it hangs off; neither is a route.
    assert.equal(site.discovered, 4, 'only real destinations are queued');
    assert.equal(site.remaining, 0);

    // One ledger across routes: the stylesheet is fetched once and reused after.
    assert.equal(site.assets.unique, 1);
    assert.equal(site.routes.filter((route) => route.reused > 0).length, 3);

    // A pdf is a same-origin destination the crawl deliberately refuses, so it
    // keeps its original address and is counted rather than quietly rewritten.
    assert.equal(site.links.unresolved, 4, 'the pdf link on each of the four routes');
    assert.equal(site.links.external, 4, 'one off-site link on each of the four routes');
    assert.equal(site.links.rewritten, 20, 'four routes plus a fragment, on each of four pages');
    assert.equal(site.fidelity.lowest, 1, `worst route ${site.fidelity.lowestRoute}: ${site.fidelity.weakest}`);

    // Depth decides the prefix, and the entry is reachable from the deepest page.
    const deep = await readFile(join(dir, 'docs', 'install', 'index.html'), 'utf8');
    assert.match(deep, /href="\.\.\/\.\.\/index\.html"/, 'home must be reachable from a nested route');
    assert.match(deep, /href="\.\.\/index\.html"/, 'the parent route sits one level up');
    assert.match(deep, /href="\.\/index\.html"/, 'a route links to itself as its own file');
    assert.match(deep, /<link[^>]+href="\.\.\/\.\.\/assets\//, 'assets are relative to the route, not the root');
    assert.doesNotMatch(deep, /index\.html\/install/, 'the /docs prefix must not splice into /docs/install');
    // A fragment hangs off a route that was cloned, so it follows it locally.
    assert.match(deep, /href="\.\.\/index\.html#anchor"/);
    assert.match(deep, /href="\/paper\.pdf"/, 'a destination the crawl refuses keeps its address');

    // Every rewritten link must resolve once the clone is served.
    const served = await serveDirectory(dir);
    try {
      let checked = 0;
      for (const route of site.routes) {
        const html = await readFile(join(dir, route.path), 'utf8');
        for (const match of html.matchAll(/href="(\.[^"]*)"/g)) {
          const response = await fetch(new URL(match[1], new URL(route.path, served.url)));
          assert.equal(response.status, 200, `${route.path} -> ${match[1]}`);
          checked += 1;
        }
      }
      assert.ok(checked >= 16, `expected every route to link to every other, checked ${checked}`);
    } finally {
      await served.close();
    }

    assert.ok(cssRequests >= 4, 'each route loads in its own browser, so the origin is hit per route');
  } finally {
    origin.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a route cap keeps the pages nearest the entry', async (t) => {
  try {
    chromePath();
  } catch {
    t.skip('no Chrome or Chromium on this machine');
    return;
  }

  // Home links to one and two; only two links to three. A cap of 2 must stop
  // before three, and must report that something was left in the queue.
  const link = (href, text) => `<a href="${href}">${text}</a>`;
  const pages = {
    '/': `<!doctype html><html><body>${link('/one', 'one')}${link('/two', 'two')}</body></html>`,
    '/one': `<!doctype html><html><body>${link('/', 'home')}</body></html>`,
    '/two': `<!doctype html><html><body>${link('/three', 'three')}</body></html>`,
    '/three': '<!doctype html><html><body>deep</body></html>',
  };

  const origin = createServer((request, response) => {
    const body = pages[request.url];
    response.writeHead(body ? 200 : 404, { 'content-type': 'text/html' });
    response.end(body ?? 'not found');
  });
  await new Promise((ready) => origin.listen(0, '127.0.0.1', ready));

  const url = `http://127.0.0.1:${origin.address().port}/`;
  const dir = join(tmpdir(), `design-os-cap-test-${process.pid}`);

  try {
    const site = await cloneSite({ url, dir, routes: 2, wait: 3000, verify: false });

    assert.equal(site.cloned, 2);
    assert.deepEqual(site.routes.map((route) => route.path), ['index.html', 'one/index.html']);
    assert.ok(site.remaining >= 1, 'the cap must leave the rest of the queue visible');
    assert.equal(site.fidelity, null, 'verification was not asked for');

    // /two was found but not cloned, so its link stays pointing at the site.
    const home = await readFile(join(dir, 'index.html'), 'utf8');
    assert.match(home, /href="\.\/one\/index\.html"/);
    assert.match(home, /href="\/two"/, 'an uncloned route keeps its original address');
  } finally {
    origin.close();
    await rm(dir, { recursive: true, force: true });
  }
});
