import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { serve } from '../src/mcp.js';

/**
 * Drives the server over in-memory streams and returns every message it wrote.
 *
 * The specification is strict that stdout carries MCP messages and nothing else,
 * so the harness parses every line without tolerance: a stray write fails here
 * rather than in a client.
 */
async function converse(requests) {
  const input = new PassThrough();
  const output = new PassThrough();

  const replies = [];
  let buffered = '';
  output.on('data', (chunk) => {
    buffered += chunk;
    let boundary = buffered.indexOf('\n');
    while (boundary !== -1) {
      const line = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 1);
      boundary = buffered.indexOf('\n');
      replies.push(JSON.parse(line));
    }
  });

  const served = serve({ input, output });
  for (const request of requests) input.write(`${JSON.stringify(request)}\n`);
  input.end();
  await served;

  assert.equal(buffered, '', 'every message must end in a newline');
  return replies;
}

test('initialize negotiates a version and declares the tools capability', async () => {
  const [reply] = await converse([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
  ]);

  assert.equal(reply.jsonrpc, '2.0');
  assert.equal(reply.id, 1);
  assert.equal(reply.result.protocolVersion, '2025-06-18');
  assert.deepEqual(reply.result.capabilities, { tools: { listChanged: false } });
  assert.equal(reply.result.serverInfo.name, 'design-os');
});

test('an unknown protocol version falls back to the newest supported', async () => {
  const [reply] = await converse([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
  ]);
  assert.equal(reply.result.protocolVersion, '2025-06-18');
});

test('notifications are never answered', async () => {
  const replies = await converse([
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } },
    { jsonrpc: '2.0', id: 7, method: 'ping' },
  ]);

  assert.equal(replies.length, 1, 'only the ping carries an id, so only the ping is answered');
  assert.equal(replies[0].id, 7);
  assert.deepEqual(replies[0].result, {});
});

test('every tool declares a schema the model can fill in', async () => {
  const [reply] = await converse([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
  const names = reply.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, ['design_inspect', 'design_clone', 'design_directions']);

  for (const tool of reply.result.tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.description.length > 40, `${tool.name} needs a description a model can act on`);
    assert.ok(Object.keys(tool.inputSchema.properties).length > 0);
  }
  assert.deepEqual(reply.result.tools[0].inputSchema.required, ['url']);
  const clone = reply.result.tools.find((tool) => tool.name === 'design_clone');
  assert.deepEqual(clone.inputSchema.required, ['url']);
  assert.equal(clone.inputSchema.properties.scripts.default, false, 'a rendered DOM plus live scripts double-hydrates');
  assert.equal(clone.inputSchema.properties.skipVerify.default, false, 'a clone is verified unless asked otherwise');
});

test('an unknown method is a protocol error, not a tool result', async () => {
  const [reply] = await converse([{ jsonrpc: '2.0', id: 1, method: 'resources/list' }]);
  assert.equal(reply.error.code, -32601);
  assert.equal(reply.result, undefined);
});

test('an unknown tool is a protocol error; a failing tool is a result', async () => {
  const [unknown, failing] = await converse([
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'design_nope', arguments: {} } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'design_inspect', arguments: { url: 'ftp://x' } } },
  ]);

  assert.equal(unknown.error.code, -32602);

  assert.equal(failing.error, undefined, 'work that failed is reported in the result');
  assert.equal(failing.result.isError, true);
  const envelope = JSON.parse(failing.result.content[0].text);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, 'USAGE_ERROR');
  assert.match(envelope.error.message, /only http and https/);
});

test('malformed input is answered without killing the session', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const replies = [];
  output.on('data', (chunk) => {
    for (const line of String(chunk).split('\n').filter(Boolean)) replies.push(JSON.parse(line));
  });

  const served = serve({ input, output });
  input.write('{ this is not json }\n');
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`);
  input.end();
  await served;

  assert.equal(replies[0].error.code, -32700);
  assert.equal(replies[0].id, null);
  assert.equal(replies[1].id, 2, 'the session survives a bad line');
});

test('a tool result carries the same envelope the CLI prints', async () => {
  const [reply] = await converse([
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'design_directions', arguments: { count: 4, seed: 'monozukuri' } },
    },
  ]);

  assert.equal(reply.result.isError, undefined);
  const envelope = JSON.parse(reply.result.content[0].text);
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.command, 'directions');
  assert.equal(envelope.data.count, 4);
  assert.equal(envelope.data.directions.length, 4);
});
