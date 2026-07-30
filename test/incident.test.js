import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdir, rm, writeFile, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { chromePath, reapOrphans } from '../src/cdp.js';
import { runTool } from '../src/tools.js';

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
  body { background: #101018; color: #eee; margin: 0; padding: 20px; font-family: sans-serif }
</style></head><body><main><h1>Held</h1></main></body></html>`;

const profiles = async () =>
  (await readdir(tmpdir()).catch(() => [])).filter((entry) => entry.startsWith('design-os-chrome-'));

test('work that cannot finish in the caller’s window is refused before a browser starts', async () => {
  // A tool call carries a deadline; a terminal does not. Five routes with
  // verification is around four hundred seconds, so it cannot be attempted over
  // a transport that gives up after one minute.
  const refused = await runTool('design_clone', { url: 'stripe.com', routes: 5 });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'USAGE_ERROR');
  assert.match(refused.error.message, /needs about \d+s and this caller allows 55s/);
  // The message has to say what to do instead, or it is just a wall.
  assert.match(refused.error.message, /fewer routes|skipVerify|terminal/);

  // An explicit undefined must not erase the budget: spreading arguments over a
  // default is an easy way to remove a guard by accident.
  const stillRefused = await runTool('design_clone', { url: 'stripe.com', routes: 5, deadline: undefined });
  assert.equal(stillRefused.ok, false);
  assert.match(stillRefused.error.message, /allows 55s/);

  // A batch is not refused, because its ledger already makes a second call a
  // resume: it does what fits and says how to continue. Refusing it outright made
  // the feature unreachable from the very surface it was built for.
  const missing = await runTool('design_batch', { from: '/nonexistent.txt' });
  assert.equal(missing.ok, false);
  assert.match(missing.error.message, /cannot read/, 'a missing list is a missing list, not a timing problem');
});

test('a second browser-driving call is refused, not run alongside the first', async (t) => {
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
  const url = `http://127.0.0.1:${origin.address().port}/`;

  try {
    // A caller whose first call was abandoned by its transport retries. Without
    // a guard the retry starts a second browser while the first is still working,
    // which is how a stack of timed-out calls became unresponsive processes.
    const first = runTool('design_inspect', { url, wait: 5000, deadline: 0 });
    await new Promise((settle) => setTimeout(settle, 1200));

    const second = await runTool('design_inspect', { url, wait: 5000, deadline: 0 });
    assert.equal(second.ok, false, 'the retry must be refused while the first is running');
    assert.match(second.error.message, /already running an inspection/);
    assert.match(second.error.message, /Wait for it, or stop it/);

    assert.equal((await first).ok, true, 'and the first must be unaffected');

    // The lock is released, so the next caller is not locked out for good.
    const after = await runTool('design_inspect', { url, wait: 4000, deadline: 0 });
    assert.equal(after.ok, true);
  } finally {
    origin.close();
  }
});

test('a browser abandoned by a killed launcher is cleared, not left running', async (t) => {
  try {
    chromePath();
  } catch {
    t.skip('no Chrome or Chromium on this machine');
    return;
  }

  const scratch = await mkdtemp(join(tmpdir(), 'design-os-incident-'));
  const script = join(scratch, 'abandon.mjs');

  // Opens a browser and then never closes it. Killing this outright leaves the
  // browser reparented and holding its profile: the state the field report
  // described, where processes burn cpu with nobody left to talk to them.
  await writeFile(
    script,
    `import { openPage } from '${join(process.cwd(), 'src', 'cdp.js')}';\n` +
      `await openPage();\nprocess.stdout.write('open\\n');\nawait new Promise(() => {});\n`,
  );

  const before = await profiles();
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'ignore'] });

  try {
    await new Promise((ready, fail) => {
      const timer = setTimeout(() => fail(new Error('the child never opened a browser')), 45_000);
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes('open')) {
          clearTimeout(timer);
          ready();
        }
      });
    });

    const during = await profiles();
    assert.ok(during.length > before.length, 'a profile should exist while the browser is open');

    // Killed outright: no finally block runs, nothing is closed.
    child.kill('SIGKILL');
    await new Promise((settle) => setTimeout(settle, 2500));

    // Assert on this test's own profile, not on global counts: another design-os
    // may legitimately be running, and its profile is correctly skipped.
    const abandoned = during.filter((entry) => !before.includes(entry));
    assert.equal(abandoned.length, 1, `expected one new profile, saw ${abandoned.length}`);

    await reapOrphans();
    assert.ok(
      !(await profiles()).includes(abandoned[0]),
      `the abandoned profile ${abandoned[0]} was left behind`,
    );

    // Reaping again finds nothing more of ours to do.
    const again = await reapOrphans();
    assert.equal(again.browsers, 0);
  } finally {
    child.kill('SIGKILL');
    await rm(scratch, { recursive: true, force: true });
    await reapOrphans();
  }
});
