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
  design-os batch --from <file> [options]
  design-os mcp

Commands:
  directions        generate deterministic design directions and a gallery
  inspect           load a url once and report its rendering pipeline and design
  clone             copy a url, or crawl a site, then load it back and score it
  batch             clone every target in a list file, resumably
  mcp               serve every tool over MCP stdio

directions options:
  --count <n>       directions to generate, 1-64             (default 12)
  --seed <text>     identical seeds reproduce output          (default random)
  --polarity <p>    light | dark | both                       (default both)

inspect and clone options:
  --wait <ms>       ceiling on waiting for network idle       (default 15000)
  --timeout <ms>    per-operation Chrome timeout              (default 30000)
  --modes <list>    also read the design in dark and/or light
  --screenshot      also write a PNG of the loaded page
  --gallery         render the extracted direction as HTML    (inspect)

batch options:
  --from <file>     one url or hostname per line, # for comments
  --ledger <path>   progress record        (default .design-os/batch-<name>.json)
  --retry           re-clone targets already recorded as done

clone options:
  --no-vite         skip the package.json and Vite config a clone normally gets
  --routes <n>      routes to crawl breadth-first from the url    (default 1)
  --layout <l>      flat | fsd, Feature-Sliced Design tree         (default flat)
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
  routes: { type: 'string' },
  from: { type: 'string' },
  ledger: { type: 'string' },
  retry: { type: 'boolean', default: false },
  modes: { type: 'string' },
  layout: { type: 'string' },
  screenshot: { type: 'boolean', default: false },
  gallery: { type: 'boolean', default: false },
  scripts: { type: 'boolean', default: false },
  'skip-verify': { type: 'boolean', default: false },
  'no-vite': { type: 'boolean', default: false },
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
  // A negative flag reads well on a command line and badly in an option object,
  // so it is turned the right way round once, here.
  const { 'skip-verify': skipVerify, 'no-vite': noVite, ...values } = parsed.values;
  const envelope = await handler({ ...values, skipVerify, vite: !noVite, url: target });
  const code = emit(envelope);

  // A served clone lives for as long as its process. The tool surfaces run
  // inside a host that persists; this one exits, so it waits instead.
  if (command === 'serve' && envelope.ok && envelope.data.url) {
    progress('Serving until interrupted. Ctrl-C to stop.');
    await new Promise(() => {});
  }
  return code;
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
