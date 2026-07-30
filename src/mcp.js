/**
 * MCP server over stdio.
 *
 * The transport is line-delimited JSON-RPC 2.0. The specification is explicit
 * that stdout carries MCP messages and nothing else, which is why this module
 * never calls `emit`: the envelope a command returns is serialised into the tool
 * result instead. Commands already send their progress to stderr, so the message
 * stream cannot be corrupted by a chatty command.
 *
 * Tools call `src/commands.js` directly, the same entry point the CLI uses. A
 * failed command comes back as a result carrying the failure envelope with
 * `isError`, per the specification's split: protocol errors are for messages the
 * server could not understand, tool errors are for work that did not succeed.
 */

import { createRequire } from 'node:module';

import { HANDLERS, TOOLS, runTool } from './tools.js';

const { version } = createRequire(import.meta.url)('../package.json');

/** Newest first. An unknown request falls back to the newest we implement. */
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const PARSE_ERROR = -32700;

const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

async function callTool(params) {
  if (!HANDLERS[params?.name]) throw new RpcError(INVALID_PARAMS, `unknown tool: ${params?.name}`);
  const envelope = await runTool(params.name, params.arguments ?? {});
  return envelope.ok ? text(envelope) : { ...text(envelope), isError: true };
}
class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function initialize(params) {
  const requested = params?.protocolVersion;
  return {
    protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'design-os', title: 'design-os', version },
  };
}

const ROUTES = {
  initialize,
  ping: () => ({}),
  'tools/list': () => ({ tools: TOOLS }),
  'tools/call': callTool,
};

/**
 * Serves MCP on stdin/stdout until stdin closes.
 *
 * @returns {Promise<number>} process exit code
 */
export function serve({ input = process.stdin, output = process.stdout } = {}) {
  const reply = (message) => output.write(`${JSON.stringify(message)}\n`);

  async function dispatch(message) {
    // Notifications carry no id and must never be answered.
    const isRequest = message.id !== undefined && message.id !== null;
    const route = ROUTES[message.method];

    if (!route) {
      if (isRequest) {
        reply({ jsonrpc: '2.0', id: message.id, error: { code: METHOD_NOT_FOUND, message: `unknown method: ${message.method}` } });
      }
      return;
    }

    try {
      const result = await route(message.params);
      if (isRequest) reply({ jsonrpc: '2.0', id: message.id, result });
    } catch (error) {
      if (!isRequest) throw error;
      reply({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: error instanceof RpcError ? error.code : PARSE_ERROR, message: error.message },
      });
    }
  }

  return new Promise((resolve) => {
    let buffered = '';
    let queue = Promise.resolve();

    input.setEncoding('utf8');
    input.on('data', (chunk) => {
      buffered += chunk;
      let boundary = buffered.indexOf('\n');

      while (boundary !== -1) {
        const line = buffered.slice(0, boundary).trim();
        buffered = buffered.slice(boundary + 1);
        boundary = buffered.indexOf('\n');
        if (!line) continue;

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          reply({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: error.message } });
          continue;
        }
        // Serialised: a client may pipeline requests, and Chrome is not reentrant.
        queue = queue.then(() => dispatch(message));
      }
    });

    input.on('end', () => queue.then(() => resolve(0)));
  });
}
