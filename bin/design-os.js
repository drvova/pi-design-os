#!/usr/bin/env node
/**
 * design-os control plane.
 *
 * Parsing and dispatch only. The commands themselves live in src/commands.js so
 * the MCP server runs the identical code path. Exactly one JSON envelope goes to
 * stdout; progress goes to stderr. Exit codes follow src/envelope.js, so a shell
 * agent can branch on them without parsing anything.
 */

import { parseArgs } from 'node:util';

import { COMMANDS } from '../src/commands.js';
import { CommandError, EXIT, emit, fail, ok, progress, usage } from '../src/envelope.js';
import { serve } from '../src/mcp.js';

const HELP = `design-os — explore design directions, and read them off real sites

Usage:
  design-os directions [options]
  design-os inspect <url> [options]
  design-os clone <url> [options]
  design-os mcp

Commands:
  directions        generate deterministic design directions and a gallery
  inspect           load a url once and report its rendering pipeline and design
  clone             write a runnable local copy of a url, then verify it
  mcp               serve the three tools over MCP stdio

directions options:
  --count <n>       directions to generate, 1-64             (default 12)
  --seed <text>     identical seeds reproduce output          (default random)
  --polarity <p>    light | dark | both                       (default both)

inspect and clone options:
  --wait <ms>       ceiling on waiting for network idle       (default 15000)
  --timeout <ms>    per-operation Chrome timeout              (default 30000)
  --screenshot      also write a PNG of the loaded page
  --gallery         render the extracted direction as HTML    (inspect)

clone options:
  --budget <mb>     asset size budget, lowest priority cut first  (default 40)
  --scripts         keep the page's scripts wired up instead of disabling them
  --skip-verify     do not load the clone back and score it

shared options:
  --out <path>      artefact destination                      (default .design-os/)
  --open            open the result in the browser
  --help            show this message

One JSON envelope goes to stdout; progress goes to stderr.
`;

const OPTIONS = {
  count: { type: 'string' },
  seed: { type: 'string' },
  polarity: { type: 'string' },
  out: { type: 'string' },
  wait: { type: 'string' },
  timeout: { type: 'string' },
  budget: { type: 'string' },
  screenshot: { type: 'boolean', default: false },
  gallery: { type: 'boolean', default: false },
  scripts: { type: 'boolean', default: false },
  'skip-verify': { type: 'boolean', default: false },
  open: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
};

const KNOWN = [...Object.keys(COMMANDS), 'mcp'];

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    throw usage(error.message);
  }

  const [command, target] = parsed.positionals;

  if (parsed.values.help || !command) {
    process.stderr.write(HELP);
    return emit(ok('help', { commands: KNOWN }));
  }

  // A transport, not a command: it owns stdout for the whole session.
  if (command === 'mcp') return serve();

  const handler = COMMANDS[command];
  if (!handler) throw usage(`unknown command "${command}". Known commands: ${KNOWN.join(', ')}`);

  // parseArgs keeps the dashed spelling; commands take one camelCase shape.
  const { 'skip-verify': skipVerify, ...values } = parsed.values;
  return emit(await handler({ ...values, skipVerify, url: target }));
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof CommandError) {
    process.exitCode = emit(fail('design-os', error.code, error.message));
  } else {
    emit(fail('design-os', 'OPERATION_FAILED', error.message));
    progress(error.stack ?? String(error));
    process.exitCode = EXIT.OPERATION_FAILED;
  }
}
