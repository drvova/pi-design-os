#!/usr/bin/env node
/**
 * design-os control plane.
 *
 * Exactly one JSON envelope goes to stdout; progress goes to stderr. Exit codes
 * follow src/envelope.js so shell agents can branch on them without parsing.
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { generate } from '../src/directions.js';
import { CommandError, EXIT, emit, fail, ok, progress, usage } from '../src/envelope.js';
import { render } from '../src/gallery.js';

const HELP = `design-os — explore dozens of design directions

Usage:
  design-os directions [options]

Options:
  --count <n>       directions to generate, 1-64        (default 12)
  --seed <text>     identical seeds reproduce output    (default random)
  --polarity <p>    light | dark | both                 (default both)
  --out <path>      gallery destination                 (default .design-os/directions.html)
  --open            open the gallery in the browser
  --help            show this message
`;

const OPTIONS = {
  count: { type: 'string' },
  seed: { type: 'string' },
  polarity: { type: 'string' },
  out: { type: 'string' },
  open: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
};

/** Opens a path with the platform's default handler. */
function openInBrowser(target) {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(command, [target], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' })
    .unref();
}

function parseCount(raw) {
  if (raw === undefined) return 12;
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1 || count > 64) {
    throw usage(`--count must be an integer between 1 and 64, received "${raw}"`);
  }
  return count;
}

function parsePolarity(raw) {
  const polarity = raw ?? 'both';
  if (!['light', 'dark', 'both'].includes(polarity)) {
    throw usage(`--polarity must be light, dark, or both, received "${raw}"`);
  }
  return polarity;
}

async function directions(values) {
  const count = parseCount(values.count);
  const polarity = parsePolarity(values.polarity);
  const seed = values.seed ?? Math.random().toString(36).slice(2, 10);
  const out = resolve(values.out ?? '.design-os/directions.html');

  progress(`Generating ${count} directions from seed "${seed}"...`);
  const generated = generate({ count, seed, polarity });

  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, render(generated, { seed, title: `${count} directions` }), 'utf8');
  progress(`Wrote ${out}`);

  if (values.open) {
    openInBrowser(out);
    progress('Opened in browser.');
  }

  return ok('directions', {
    count,
    seed,
    polarity,
    path: out,
    directions: generated.map(({ id, label, body, axes }) => ({ id, label, body, axes })),
  });
}

const COMMANDS = { directions };

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    throw usage(error.message);
  }

  const [command] = parsed.positionals;

  if (parsed.values.help || !command) {
    process.stderr.write(HELP);
    return emit(ok('help', { commands: Object.keys(COMMANDS) }));
  }

  const handler = COMMANDS[command];
  if (!handler) {
    throw usage(`unknown command "${command}". Known commands: ${Object.keys(COMMANDS).join(', ')}`);
  }

  return emit(await handler(parsed.values));
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof CommandError) {
    process.exitCode = emit(fail('design-os', error.code, error.message));
  } else {
    process.exitCode = emit(fail('design-os', 'OPERATION_FAILED', error.message));
    progress(error.stack ?? String(error));
    process.exitCode = EXIT.OPERATION_FAILED;
  }
}
