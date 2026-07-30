import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { chromePath } from '../src/cdp.js';
import { runTool } from '../src/tools.js';

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
  body { background: #101018; color: #eee; margin: 0; padding: 20px; font-family: sans-serif }
  .card { border-radius: 12px; padding: 16px }
</style></head><body><main><h1>Batch</h1><div class="card">a</div><div class="card">b</div></main></body></html>`;

test('a list of targets is read the way a list is written', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'design-os-batch-'));
  const list = join(dir, 'sites.txt');

  try {
    // A gallery export has comments, blank lines and repeats.
    await writeFile(list, ['# heading', '', 'ftp://one', '  ftp://two  ', 'ftp://one', '', '# trailing'].join('\n'));

    const result = await runTool('design_batch', { from: list, ledger: join(dir, 'ledger.json'), skipVerify: true });
    assert.equal(result.ok, true);
    // Three lines of targets, two distinct: a browser launch per duplicate is
    // minutes spent for nothing.
    assert.equal(result.data.targets, 2);
    assert.deepEqual(Object.keys(result.data.rows), ['ftp://one', 'ftp://two']);

    const empty = await runTool('design_batch', { from: join(dir, 'blank.txt') });
    assert.equal(empty.ok, false);
    assert.match(empty.error.message, /cannot read/);

    await writeFile(join(dir, 'onlycomments.txt'), '# nothing here\n\n');
    const none = await runTool('design_batch', { from: join(dir, 'onlycomments.txt') });
    assert.equal(none.ok, false);
    assert.match(none.error.message, /no targets/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('one unreachable target does not discard the rest of the run', async (t) => {
  try {
    chromePath();
  } catch {
    t.skip('no Chrome or Chromium on this machine');
    return;
  }

  const origin = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(PAGE);
  });
  await new Promise((ready) => origin.listen(0, '127.0.0.1', ready));
  const good = `http://127.0.0.1:${origin.address().port}/`;

  const dir = await mkdtemp(join(tmpdir(), 'design-os-batch-'));
  const list = join(dir, 'mixed.txt');
  const ledger = join(dir, 'ledger.json');

  try {
    // The bad one is first, so a pass that aborts on failure produces nothing.
    await writeFile(list, ['ftp://not-a-website', good].join('\n'));

    const first = await runTool('design_batch', {
      from: list,
      ledger,
      out: join(dir, 'clones'),
      skipVerify: true,
    });

    assert.equal(first.ok, true, 'the batch itself succeeds even when a target does not');
    assert.equal(first.data.failed, 1);
    assert.equal(first.data.cloned, 1);

    const rows = first.data.rows;
    assert.equal(rows['ftp://not-a-website'].ok, false);
    assert.equal(rows['ftp://not-a-website'].code, 'USAGE_ERROR');
    assert.equal(rows[good].ok, true, 'the target after the failure still ran');
    assert.ok(rows[good].clone, 'and its clone is on disk');

    // Written after every target, which is what makes an interrupted run resume.
    const recorded = JSON.parse(await readFile(ledger, 'utf8'));
    assert.equal(recorded.from, list);
    assert.deepEqual(Object.keys(recorded.rows).sort(), ['ftp://not-a-website', good].sort());

    // A second pass is a resume: what worked is left alone, what failed is tried
    // again, because a failure is usually the network rather than the target.
    const second = await runTool('design_batch', { from: list, ledger, out: join(dir, 'clones'), skipVerify: true });
    assert.equal(second.data.skipped, 1);
    assert.equal(second.data.cloned, 0);
    assert.equal(second.data.failed, 1);

    // And retry means retry.
    const forced = await runTool('design_batch', { from: list, ledger, out: join(dir, 'clones'), skipVerify: true, retry: true });
    assert.equal(forced.data.skipped, 0);
    assert.equal(forced.data.cloned, 1);
  } finally {
    origin.close();
    await rm(dir, { recursive: true, force: true });
  }
});
