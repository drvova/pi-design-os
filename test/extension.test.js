import assert from 'node:assert/strict';
import test from 'node:test';

import designOs from '../extensions/design-os.js';
import { TOOLS, runTool } from '../src/tools.js';

/** Captures what the extension registers, the way Pi would. */
function load() {
  const registered = new Map();
  designOs({ registerTool: (tool) => registered.set(tool.name, tool) });
  return registered;
}

test('the extension registers every declared tool', () => {
  const registered = load();
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
  const registered = load();
  for (const declared of TOOLS) {
    const tool = registered.get(declared.name);
    // Not a copy: the identical object, so the two front ends cannot drift.
    assert.equal(tool.parameters, declared.inputSchema);
    assert.equal(tool.description, declared.description);
  }
});

test('a tool returns its envelope as text', async () => {
  const registered = load();
  const result = await registered.get('design_directions').execute('call-1', { count: 3, seed: 'monozukuri' });

  assert.equal(typeof result, 'string', 'Pi renders a tool result as text');
  const envelope = JSON.parse(result);
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.command, 'directions');
  assert.equal(envelope.data.directions.length, 3);
});

test('a failing tool throws, carrying the wire code', async () => {
  const registered = load();
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
