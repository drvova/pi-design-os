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

import { COMMANDS } from './commands.js';
import { CommandError, fail } from './envelope.js';

const { version } = createRequire(import.meta.url)('../package.json');

/** Newest first. An unknown request falls back to the newest we implement. */
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const PARSE_ERROR = -32700;

const TOOLS = [
  {
    name: 'design_inspect',
    title: 'Inspect a site’s rendering pipeline and design',
    description:
      'Loads a url in headless Chrome once, with instrumentation installed before the document is parsed, ' +
      'and reports the whole pipeline: what the parser was handed before a DOM existed, what ran before ' +
      'DOMContentLoaded, what ran after it, every asset in request order, which browser APIs were called and ' +
      'in which phase, how the DOM was rewritten, whether appearance comes from CSS or from JavaScript, and a ' +
      'runtime trace. Also extracts the rendered design — palette in OKLCH, type scale, spacing, radius, shadow ' +
      'and motion — as a design direction usable as inspiration.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Site to inspect. A bare hostname is treated as https.' },
        wait: {
          type: 'integer',
          description: 'Ceiling in ms on waiting for network idle. Raise for heavy sites.',
          minimum: 500,
          maximum: 120000,
          default: 15000,
        },
        timeout: {
          type: 'integer',
          description: 'Per-operation Chrome timeout in ms.',
          minimum: 5000,
          maximum: 180000,
          default: 30000,
        },
        screenshot: { type: 'boolean', description: 'Also write a PNG of the loaded page.', default: false },
        gallery: {
          type: 'boolean',
          description: 'Also render the extracted direction as a previewable HTML gallery.',
          default: false,
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'design_clone',
    title: 'Clone a site into a runnable local copy',
    description:
      'Loads a url and writes a runnable local copy: the rendered DOM after hydration, every stylesheet, ' +
      'font, image and script it fetched, and all references rewritten to the local files. CSS held only in the ' +
      'CSSOM — everything a CSS-in-JS library injected at runtime — is written back into the markup first, so a ' +
      'styled-components or Emotion site clones with its styling intact. Scripts are saved but disabled by ' +
      'default, making the copy a faithful static rebuild. The clone is then loaded back and scored against the ' +
      'original on palette, type, spacing and layout. Set routes above 1 to crawl the site breadth-first from ' +
      'the url, following same-origin links found in the rendered DOM; every route shares one asset ledger and ' +
      'the links between them are rewritten to point at the local files. Returns the same pipeline report ' +
      'design_inspect does, for the entry route, plus a per-route manifest.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Site to clone. A bare hostname is treated as https.' },
        out: { type: 'string', description: 'Output directory. Defaults to .design-os/clone-<host>.' },
        routes: {
          type: 'integer',
          description: 'How many routes to crawl breadth-first from the url. 1 clones only the page given.',
          minimum: 1,
          maximum: 200,
          default: 1,
        },
        layout: {
          type: 'string',
          enum: ['flat', 'fsd'],
          description:
            'flat mirrors the origin under one assets folder. fsd emits a Feature-Sliced Design tree: routes as pages slices, ' +
            'extracted components under widgets, features, entities and shared/ui, each with only the CSS that matched it, ' +
            'plus app/styles split into tokens, fonts and global, a manifest and a README.',
          default: 'flat',
        },
        budget: {
          type: 'integer',
          description: 'Asset size budget in MB. Stylesheets and fonts are saved first, scripts last.',
          minimum: 1,
          maximum: 2048,
          default: 40,
        },
        scripts: {
          type: 'boolean',
          description: 'Keep the page scripts wired up. Off by default: a rendered DOM plus live scripts means a framework hydrating onto markup it did not render.',
          default: false,
        },
        skipVerify: { type: 'boolean', description: 'Skip loading the clone back and scoring it.', default: false },
        screenshot: { type: 'boolean', default: false },
        wait: { type: 'integer', minimum: 500, maximum: 120000, default: 15000 },
      },
      required: ['url'],
    },
  },
  {
    name: 'design_directions',
    title: 'Generate design directions',
    description:
      'Generates N deterministic design directions as OKLCH token sets and writes a gallery. Hues are spread ' +
      'evenly around the wheel so the directions differ meaningfully rather than by accident. The same seed ' +
      'always reproduces the same output.',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'integer', description: 'How many directions.', minimum: 1, maximum: 64, default: 12 },
        seed: { type: 'string', description: 'Identical seeds reproduce identical directions.' },
        polarity: { type: 'string', enum: ['light', 'dark', 'both'], default: 'both' },
      },
    },
  },
];

/** Tool name to command name. */
const HANDLERS = { design_inspect: 'inspect', design_clone: 'clone', design_directions: 'directions' };

const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

async function callTool(params) {
  const command = HANDLERS[params?.name];
  if (!command) {
    throw new RpcError(INVALID_PARAMS, `unknown tool: ${params?.name}`);
  }

  try {
    return text(await COMMANDS[command](params.arguments ?? {}));
  } catch (error) {
    const code = error instanceof CommandError ? error.code : 'OPERATION_FAILED';
    if (!(error instanceof CommandError)) process.stderr.write(`${error.stack ?? error}\n`);
    return { ...text(fail(command, code, error.message)), isError: true };
  }
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
