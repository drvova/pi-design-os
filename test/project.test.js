import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { chromePath } from '../src/cdp.js';
import { COMMANDS } from '../src/commands.js';
import { devProjectNotes, writeDevProject } from '../src/project.js';

const HOME = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Home</title><style>
  body { background: #101018; color: #eee; font-family: sans-serif; margin: 0 }
  main { padding: 2rem } header { padding: 1rem; background: #191927 }
</style></head><body><header><nav><a href="/">Home</a> <a href="/two">Two</a></nav></header>
<main><h1>Home</h1></main></body></html>`;

test('a clone becomes a project whose every build entry is a real file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'design-os-project-'));
  try {
    // Two distinct routes, one of them listed twice: a route reached from two
    // pages is still one page, and building it under two names is waste.
    const routes = [
      { path: 'pages/home/ui/index.html' },
      { path: 'pages/two/ui/index.html' },
      { path: 'pages/home/ui/index.html' },
    ];
    for (const route of new Set(routes.map((r) => r.path))) {
      await mkdir(join(root, dirname(route)), { recursive: true });
      await writeFile(join(root, route), HOME, 'utf8');
    }
    await writeFile(join(root, 'index.html'), HOME, 'utf8');

    const written = await writeDevProject(root, { name: 'example.com', routes });
    assert.equal(written.written, true);
    assert.equal(written.pages, 3, 'two routes and the entry, with the repeat collapsed');

    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.scripts), ['dev', 'build', 'preview']);
    assert.equal(manifest.private, true, 'a clone is not something to publish by accident');
    assert.match(manifest.name, /^clone-example-com$/);
    assert.ok(manifest.devDependencies.vite, 'vite belongs to the clone, not to design-os');

    // The config has to be real javascript, not merely look like it.
    const config = (await import(join(root, 'vite.config.js'))).default;
    assert.equal(config.appType, 'mpa', 'without this a missing page silently serves the entry instead');

    const input = config.build.rollupOptions.input;
    assert.equal(Object.keys(input).length, 3);
    assert.equal(new Set(Object.values(input)).size, 3, 'no two entries may build the same file');

    // The invariant that decides whether `vite build` runs at all: an entry that
    // names a file which is not there fails the build on the first page.
    for (const [name, path] of Object.entries(input)) {
      await access(join(root, path));
      assert.match(name, /^[a-z0-9-]+$/, `${name} must be usable as an output name`);
    }
    assert.ok(Object.values(input).includes('index.html'), 'a build with no front door is not openable');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a mirror declines the project rather than half-serving it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'design-os-mirror-'));
  try {
    const declined = await writeDevProject(root, { name: 'x', routes: [{ path: 'index.html' }], mirror: true });
    assert.equal(declined.written, false);
    assert.match(declined.reason, /own scripts/);

    // Nothing is written, because a dev server handed a production bundle it did
    // not build would rewrite urls the site's own loader constructs at runtime.
    assert.deepEqual(await readdir(root), []);

    // The readme still has to say how to run it, or the copy looks unusable.
    const notes = devProjectNotes(declined).join('\n');
    assert.match(notes, /## Running it/);
    assert.match(notes, /design-os serve/);
    assert.doesNotMatch(notes, /npm run dev/, 'offering a dev server that cannot work is worse than silence');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a real clone is editable, and can be told not to be', async (t) => {
  try {
    chromePath();
  } catch {
    t.skip('no Chrome or Chromium on this machine');
    return;
  }

  const origin = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(HOME.replace('<h1>Home</h1>', `<h1>${request.url}</h1>`));
  });
  await new Promise((ready) => origin.listen(0, '127.0.0.1', ready));
  const url = `http://127.0.0.1:${origin.address().port}/`;

  const out = await mkdtemp(join(tmpdir(), 'design-os-clone-project-'));
  const off = await mkdtemp(join(tmpdir(), 'design-os-clone-plain-'));
  try {
    const shared = { url, routes: 2, layout: 'fsd', skipVerify: true, wait: 3000, deadline: 0 };

    const on = await COMMANDS.clone({ ...shared, out });
    assert.equal(on.ok, true);
    const project = on.data.site.project;
    assert.equal(project.written, true);

    // Written last, so the entries it lists are files the crawl really produced.
    const config = (await import(join(out, 'vite.config.js'))).default;
    for (const path of Object.values(config.build.rollupOptions.input)) await access(join(out, path));

    // The readme has to describe what is actually there.
    const readme = await readFile(join(out, 'README.md'), 'utf8');
    assert.match(readme, /npm install && npm run dev/);

    const plain = await COMMANDS.clone({ ...shared, out: off, vite: false });
    assert.equal(plain.data.site.project.written, false);
    const files = await readdir(off);
    assert.ok(!files.includes('package.json') && !files.includes('vite.config.js'));
    assert.ok(files.includes('index.html'), 'declining the project must not cost the copy');
  } finally {
    origin.close();
    await rm(out, { recursive: true, force: true });
    await rm(off, { recursive: true, force: true });
  }
});
