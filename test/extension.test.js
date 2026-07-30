import assert from 'node:assert/strict';
import test from 'node:test';

import designOs from '../extensions/design-os.js';
import { TOOLS, runTool } from '../src/tools.js';

/** Captures everything the extension registers, the way Pi would. */
function load() {
  const tools = new Map();
  const commands = new Map();
  const hooks = new Map();
  designOs({
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, spec) => commands.set(name, spec),
    on: (event, handler) => hooks.set(event, handler),
  });
  return { tools, commands, hooks };
}

/** Pi calls a renderer with a theme and a component slot; both are optional. */
const theme = { fg: (_key, text) => text, bold: (text) => text };
const draw = (component, width = 100) => component.render(width).join('\n');

test('the extension registers every declared tool', () => {
  const { tools: registered } = load();
  assert.deepEqual([...registered.keys()], TOOLS.map((tool) => tool.name));

  for (const [name, tool] of registered) {
    assert.equal(typeof tool.execute, 'function', `${name} must be callable`);
    assert.ok(tool.label, `${name} needs a label`);
    assert.ok(tool.description.length > 40, `${name} needs a description a model can act on`);
    assert.equal(tool.parameters.type, 'object', `${name} must declare a JSON Schema object`);
    assert.ok(Object.keys(tool.parameters.properties).length > 0);
  }
});

test('the native surface and the MCP surface are the same declaration', () => {
  const { tools: registered } = load();
  for (const declared of TOOLS) {
    const tool = registered.get(declared.name);
    // Not a copy: the identical object, so the two front ends cannot drift.
    assert.equal(tool.parameters, declared.inputSchema);
    assert.equal(tool.description, declared.description);
  }
});

test('a tool returns its envelope as text', async () => {
  const { tools: registered } = load();
  const result = await registered.get('design_directions').execute('call-1', { count: 3, seed: 'monozukuri' });

  assert.equal(typeof result, 'string', 'Pi renders a tool result as text');
  const envelope = JSON.parse(result);
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.command, 'directions');
  assert.equal(envelope.data.directions.length, 3);
});

test('a failing tool throws, carrying the wire code', async () => {
  const { tools: registered } = load();
  await assert.rejects(
    () => registered.get('design_clone').execute('call-2', { url: 'ftp://nope' }),
    (error) => {
      // Throwing is Pi's contract for a tool that did not succeed; the code is
      // the part a caller can act on.
      assert.equal(error.code, 'USAGE_ERROR');
      assert.match(error.message, /only http and https/);
      return true;
    },
  );
});

test('an unknown tool is a different failure from a tool that failed', async () => {
  // Bad arguments come back as an envelope, because the work was attempted.
  const attempted = await runTool('design_inspect', { url: 'not a url' });
  assert.equal(attempted.ok, false);
  assert.equal(attempted.error.code, 'USAGE_ERROR');

  // A tool that does not exist is a wrong request, not failed work.
  await assert.rejects(() => runTool('design_nope', {}), /unknown tool: design_nope/);
});

test('the package points Pi at the extension and the skill', async () => {
  const { default: manifest } = await import('../package.json', { with: { type: 'json' } });
  assert.deepEqual(manifest.pi.extensions, ['./extensions/design-os.js']);
  assert.deepEqual(manifest.pi.skills, ['./skills']);
  // Shipping the entry without the folders it imports would install a broken package.
  for (const folder of ['bin', 'src', 'extensions', 'skills']) {
    assert.ok(manifest.files.includes(folder), `${folder} must be published`);
  }
});

test('slash commands cover every tool plus a doctor', () => {
  const { commands } = load();
  assert.deepEqual(
    [...commands.keys()].sort(),
    ['design-clone', 'design-directions', 'design-doctor', 'design-inspect'],
  );
  for (const [name, spec] of commands) {
    assert.equal(typeof spec.handler, 'function', `${name} needs a handler`);
    assert.ok(spec.description.length > 10, `${name} needs a description`);
  }
});

test('a command reads its arguments however Pi passes them', async () => {
  const { commands } = load();
  const clone = commands.get('design-clone');

  // Both call shapes must reach the same place: a usage line, not a crash.
  assert.match(await clone.handler('', {}), /^Usage: \/design-clone/);
  assert.match(await clone.handler({ args: '' }), /^Usage: \/design-clone/);
  assert.match(await clone.handler({}, { args: '' }), /^Usage: \/design-clone/);

  // A bad url is reported, not thrown: a command result is text on screen.
  const reported = await clone.handler('ftp://nope 3 fsd');
  assert.match(reported, /design_clone failed — USAGE_ERROR/);
  assert.match(reported, /only http and https/);
});

test('the doctor reports what a browser run needs', () => {
  const { commands } = load();
  const report = commands.get('design-doctor').handler();
  assert.match(report, /node\s+v\d+/);
  assert.match(report, /websocket\s+built in/);
  assert.match(report, /chrome\s+\S+/);
  assert.match(report, /design_inspect, design_clone, design_directions/);
});

test('a result renders as a summary, never as raw json', async () => {
  const { tools } = load();
  const directions = tools.get('design_directions');
  const output = await directions.execute('call-3', { count: 2, seed: 'monozukuri' });

  const drawn = draw(directions.renderResult(output, { isPartial: false }, theme, {}));
  assert.match(drawn, /design_directions/);
  assert.match(drawn, /2 directions · seed monozukuri/);
  // The point of a renderer is that the blob does not reach the screen.
  assert.ok(drawn.length < output.length / 4, `summary was ${drawn.length} of ${output.length} chars`);

  const running = draw(directions.renderResult('', { isPartial: true }, theme, {}));
  assert.match(running, /running/);
});

test('a renderer degrades rather than throwing on anything unexpected', () => {
  const { tools } = load();
  const render = tools.get('design_inspect').renderResult;

  // No theme, no context, and output that is not an envelope.
  assert.doesNotThrow(() => draw(render('not json at all', {}, undefined, undefined)));
  assert.match(draw(render(JSON.stringify({ ok: false, error: { message: 'boom' } }), {}, theme, {})), /failed: boom/);

  const call = tools.get('design_inspect').renderCall({ url: 'stripe.com' }, theme, {});
  assert.match(draw(call), /design_inspect stripe\.com/);
});

test('a degraded capture leads the summary, above every other number', () => {
  const { tools } = load();
  const envelope = JSON.stringify({
    ok: true,
    data: {
      capture: { degraded: true, failed: 12, requests: 15 },
      finalUrl: 'https://example.com/',
      styling: { verdict: { source: 'css', dynamicShare: 0 } },
    },
  });
  const drawn = draw(tools.get('design_inspect').renderResult(envelope, {}, theme, {}));
  const lines = drawn.split('\n');
  // A blocked page looks exactly like a static css page, so the warning cannot
  // sit below the verdict it invalidates.
  assert.ok(lines.findIndex((l) => l.includes('degraded')) < lines.findIndex((l) => l.includes('css')));
});

test('browsers left open are closed when the session ends', async () => {
  const { hooks } = load();
  const shutdown = hooks.get('session_shutdown');
  assert.equal(typeof shutdown, 'function', 'a package that starts browsers must clean them up');
  // Nothing is open, so this must be a no-op rather than a failure.
  await assert.doesNotReject(() => shutdown());
});
