/**
 * The tool surface, declared once.
 *
 * Both front ends read this: the MCP server over stdio, and the Pi extension
 * loaded in-process. A schema written twice drifts, and an agent would then see
 * a different tool depending on how it reached the same code.
 *
 * Every tool runs `src/commands.js`, the same entry point the CLI uses, and
 * comes back with the same envelope.
 */

import { COMMANDS } from './commands.js';
import { CommandError, fail } from './envelope.js';

export const TOOLS = [
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
        modes: {
          type: 'array',
          items: { type: 'string', enum: ['dark', 'light'] },
          description:
            'Extra colour schemes to read the design in. Tries prefers-color-scheme first, then the page\u2019s own theme control, ' +
            'and reports a variant only once the page is shown to have actually changed \u2014 a site that ignores the media query ' +
            'and keys theme off its own attribute would otherwise be reported twice as the same design.',
          default: [],
        },
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
        modes: {
          type: 'array',
          items: { type: 'string', enum: ['dark', 'light'] },
          description: 'Also read the design in these colour schemes. The copy itself stays in the state the page arrived in.',
          default: [],
        },
        screenshot: { type: 'boolean', default: false },
        wait: { type: 'integer', minimum: 500, maximum: 120000, default: 15000 },
      },
      required: ['url'],
    },
  },
  {
    name: 'design_batch',
    title: 'Clone every site in a list',
    description:
      'Clones every target in a list file, one url or hostname per line with # for comments. Sequential on purpose: each ' +
      'clone drives its own browser. A site that fails is recorded and the pass continues, and a ledger is written after ' +
      'every target so an interrupted run resumes where it stopped instead of starting again. Takes the same options as ' +
      'design_clone and applies them to each target. Returns one summary row per site plus the ledger path; the full ' +
      'report for each is on disk.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Path to the list file. One url or hostname per line; # starts a comment.' },
        ledger: { type: 'string', description: 'Where to record progress. Defaults to .design-os/batch-<list name>.json.' },
        retry: {
          type: 'boolean',
          description: 'Re-clone targets already recorded as done. Off by default, which is what makes a re-run a resume.',
          default: false,
        },
        routes: { type: 'integer', minimum: 1, maximum: 200, default: 1 },
        layout: { type: 'string', enum: ['flat', 'fsd'], default: 'flat' },
        modes: { type: 'array', items: { type: 'string', enum: ['dark', 'light'] }, default: [] },
        budget: { type: 'integer', minimum: 1, maximum: 2048, default: 40 },
        scripts: { type: 'boolean', default: false },
        skipVerify: { type: 'boolean', default: false },
        wait: { type: 'integer', minimum: 500, maximum: 120000, default: 15000 },
      },
      required: ['from'],
    },
  },
  {
    name: 'design_serve',
    title: 'Serve a clone and return its url',
    description:
      'Serves a clone over http and returns the url to open. A clone is a static tree and a browser refuses ' +
      'webfonts over file://, so looking at one properly means serving it. Accepts a directory, or the site the ' +
      'clone was taken from — "stripe.com" finds the directory design_clone wrote for it. Calling this twice for ' +
      'the same clone returns the same url rather than starting a second server. Pass stop to close it; pass stop ' +
      'with no dir to close every one.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: {
          type: 'string',
          description: 'Clone directory, or the site it was taken from. Omit only with stop, to close everything.',
        },
        stop: { type: 'boolean', description: 'Close the server instead of starting one.', default: false },
        open: { type: 'boolean', description: 'Also open the url in the default browser.', default: false },
      },
    },
  },
  {
    name: 'design_slices',
    title: 'Read the components a clone extracted',
    description:
      'Lists the slices a clone extracted, or returns one component in full: its markup, and the stylesheet ' +
      'containing only the rules that matched it. Needs a clone taken with layout "fsd". Without a name it ' +
      'returns every slice with its layer, how it was named, how many instances the page had, and the source ' +
      'file where the framework still reports one. With a name it returns that component so it can be read or ' +
      'rebuilt without reaching for a shell.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Clone directory, or the site it was taken from.' },
        name: {
          type: 'string',
          description: 'Slice to return, as its folder ("entities/post-card") or bare name ("post-card"). Omit to list.',
        },
      },
      required: ['dir'],
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
export const HANDLERS = {
  design_inspect: 'inspect',
  design_clone: 'clone',
  design_batch: 'batch',
  design_serve: 'serve',
  design_slices: 'slices',
  design_directions: 'directions',
};

/**
 * Runs one tool and returns its envelope.
 *
 * A tool that fails still returns an envelope, because the failure is a result:
 * the caller asked for work and the work did not succeed. An unknown tool is a
 * different thing entirely and throws, because the request itself was wrong.
 *
 * @param {string} name tool name as declared in `TOOLS`
 * @param {object} args tool arguments
 * @returns {Promise<object>} envelope, `ok` true or false
 */
export async function runTool(name, args = {}) {
  const command = HANDLERS[name];
  if (!command) throw new Error(`unknown tool: {name}`.replace('{name}', name));

  try {
    return await COMMANDS[command](args ?? {});
  } catch (error) {
    if (!(error instanceof CommandError)) process.stderr.write(`${error.stack ?? error}\n`);
    return fail(command, error instanceof CommandError ? error.code : 'OPERATION_FAILED', error.message);
  }
}
