/**
 * Pi extension.
 *
 * Pi loads this in its own process and calls each tool directly, so there is no
 * subprocess, no JSON-RPC frame and no stdio contract between the agent and the
 * work. That removes the one hazard the MCP transport has to guard against: a
 * command writing to stdout cannot corrupt a message stream when there is no
 * message stream.
 *
 * Schemas come from `src/tools.js`, the same declaration the MCP server serves,
 * and every tool runs `src/commands.js`, the same entry point the CLI uses. An
 * agent sees one tool whether it arrived natively, over MCP, or through a shell.
 *
 * Beyond the tools, three things make the package native rather than merely
 * reachable: slash commands, so the work can be run without spending a model
 * turn; result renderers, so a clone reports six lines instead of a megabyte of
 * JSON; and a shutdown hook, because this package starts real browsers and a
 * session that ends mid-crawl would otherwise leave one running.
 *
 * Paths stay relative, so artefacts land in `.design-os/` of whatever project Pi
 * is working in rather than inside this package.
 */

import { chromePath, closeAllSessions } from '../src/cdp.js';
import { TOOLS, runTool } from '../src/tools.js';

const serialise = (envelope) => JSON.stringify(envelope, null, 2);

/**
 * Failure is reported by throwing, which is Pi's contract for a tool that did
 * not succeed. The wire code stays in the message because it is the part a
 * caller can act on: `USAGE_ERROR` means fix the arguments,
 * `SERVER_UNAVAILABLE` means install Chrome.
 */
function reject(envelope) {
  const error = new Error(`${envelope.error.code}: ${envelope.error.message}`);
  error.code = envelope.error.code;
  return error;
}

/**
 * The shape Pi renders: `setText`, `invalidate`, and `render` returning lines.
 *
 * Defined here rather than imported, because it is a structural contract, not a
 * module Pi exposes. Lines are built short so width rarely matters; a line
 * carrying colour escapes is never sliced, since cutting one mid-sequence would
 * leave the terminal holding the colour open.
 */
class Lines {
  constructor(text = '') {
    this.text = text;
  }

  setText(text) {
    this.text = text;
  }

  invalidate() {}

  render(width) {
    if (!this.text || this.text.trim() === '') return [];
    return this.text.split(/\r?\n/).map((line) => (line.includes('\u001b') ? line : line.slice(0, Math.max(1, width))));
  }
}

/** Reuses the component Pi already has on screen, as its own renderers do. */
const component = (context) => (context?.lastComponent instanceof Lines ? context.lastComponent : new Lines());

const plain = (theme, key, text) => (typeof theme?.fg === 'function' ? theme.fg(key, text) : text);

/** One line naming the tool and the thing it was pointed at. */
function renderCall(name) {
  return (args, theme, context) => {
    const target = args?.url ?? (args?.seed ? `seed ${args.seed}` : '');
    const text = component(context);
    text.setText(`${plain(theme, 'toolTitle', name)}${target ? ` ${target}` : ''}`);
    return text;
  };
}

const percent = (value) => `${Math.round(value * 100)}%`;

/**
 * What the run actually produced, in a few lines.
 *
 * A clone report is hundreds of kilobytes of JSON. The numbers worth putting on
 * screen are the ones a reader would otherwise have to search for, and
 * `capture.degraded` leads because every other number describes a page that
 * never finished loading when it is true.
 */
function summarise(data) {
  if (!data) return [];
  const lines = [];

  if (data.capture?.degraded) {
    lines.push(`degraded capture: ${data.capture.failed}/${data.capture.requests} requests failed`);
  }
  if (data.finalUrl) lines.push(`${data.finalUrl}${data.title ? ` — ${data.title}` : ''}`);
  if (data.stack?.length) lines.push(`stack     ${data.stack.slice(0, 6).join(', ')}`);
  if (data.styling?.verdict) {
    lines.push(`styling   ${data.styling.verdict.source} (${data.styling.verdict.dynamicShare} dynamic)`);
  }
  if (data.direction) {
    lines.push(`direction ${data.direction.label} · ${data.direction.axes.polarity} · ${data.direction.body}`);
  }

  const site = data.site;
  if (site) {
    lines.push(`routes    ${site.cloned}/${site.discovered} discovered · ${site.assets.unique} assets`);
    if (site.slices?.length) {
      const layers = site.slices.reduce((counts, slice) => ({ ...counts, [slice.layer]: (counts[slice.layer] ?? 0) + 1 }), {});
      lines.push(`slices    ${site.slices.length} · ${Object.entries(layers).map(([layer, n]) => `${layer} ${n}`).join(' · ')}`);
    }
    if (site.links) lines.push(`links     ${site.links.rewritten} rewritten · ${site.links.unresolved} unresolved`);
  }
  if (data.fidelity) lines.push(`fidelity  ${percent(data.fidelity.score)} (lowest ${percent(data.fidelity.lowest ?? data.fidelity.score)})`);
  if (data.count) lines.push(`${data.count} directions · seed ${data.seed}`);
  for (const [label, path] of Object.entries(data.artefacts ?? {})) lines.push(`${label.padEnd(9)} ${path}`);
  if (data.path) lines.push(`gallery   ${data.path}`);

  return lines;
}

function renderResult(name) {
  return (result, state, theme, context) => {
    const text = component(context);
    if (state?.isPartial) {
      text.setText(plain(theme, 'warning', `${name} running…`));
      return text;
    }

    let envelope = null;
    try {
      envelope = JSON.parse(typeof result === 'string' ? result : (result?.output ?? ''));
    } catch {
      // A result Pi has not finished shaping is not an error; show it as given.
      text.setText(typeof result === 'string' ? result.slice(0, 400) : name);
      return text;
    }

    if (!envelope?.ok) {
      text.setText(plain(theme, 'error', `${name} failed: ${envelope?.error?.message ?? 'unknown'}`));
      return text;
    }
    text.setText([plain(theme, 'toolTitle', name), ...summarise(envelope.data)].join('\n'));
    return text;
  };
}

/** Pi has passed `(args, ctx)` and `(ctx)` across versions; accept both. */
function commandArguments(first, second) {
  if (typeof first === 'string') return first.trim();
  if (typeof first?.args === 'string') return first.args.trim();
  if (typeof second?.args === 'string') return second.args.trim();
  return '';
}

/** Runs a tool from a slash command and reports it the way the renderer does. */
async function runFromCommand(name, args) {
  const envelope = await runTool(name, args);
  if (!envelope.ok) return `${name} failed — ${envelope.error.code}: ${envelope.error.message}`;
  return [`${name} ok`, ...summarise(envelope.data)].join('\n');
}

export default function designOs(pi) {
  for (const tool of TOOLS) {
    pi.registerTool({
      name: tool.name,
      label: tool.title ?? tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      renderCall: renderCall(tool.name),
      renderResult: renderResult(tool.name),

      async execute(_toolCallId, params) {
        const envelope = await runTool(tool.name, params ?? {});
        if (!envelope.ok) throw reject(envelope);
        return serialise(envelope);
      },
    });
  }

  pi.registerCommand('design-inspect', {
    description: 'Read a url\u2019s rendering pipeline and design. Usage: /design-inspect <url>',
    handler: async (first, second) => {
      const url = commandArguments(first, second);
      if (!url) return 'Usage: /design-inspect <url>';
      return runFromCommand('design_inspect', { url });
    },
  });

  pi.registerCommand('design-clone', {
    description: 'Clone a url, or crawl a site. Usage: /design-clone <url> [routes] [fsd|flat]',
    handler: async (first, second) => {
      const [url, ...rest] = commandArguments(first, second).split(/\s+/).filter(Boolean);
      if (!url) return 'Usage: /design-clone <url> [routes] [fsd|flat]';

      const routes = rest.find((token) => /^\d+$/.test(token));
      const layout = rest.find((token) => token === 'fsd' || token === 'flat');
      return runFromCommand('design_clone', {
        url,
        ...(routes ? { routes: Number(routes) } : {}),
        ...(layout ? { layout } : {}),
      });
    },
  });

  pi.registerCommand('design-directions', {
    description: 'Generate design directions and a gallery. Usage: /design-directions [count] [seed]',
    handler: async (first, second) => {
      const [count, seed] = commandArguments(first, second).split(/\s+/).filter(Boolean);
      return runFromCommand('design_directions', {
        ...(count && /^\d+$/.test(count) ? { count: Number(count) } : {}),
        ...(seed ? { seed } : {}),
      });
    },
  });

  pi.registerCommand('design-doctor', {
    description: 'Check that design-os can drive a browser from here',
    handler: () => {
      const lines = [`node       ${process.version}`, `websocket  ${typeof WebSocket === 'function' ? 'built in' : 'missing'}`, `workspace  ${process.cwd()}/.design-os`];
      try {
        lines.push(`chrome     ${chromePath()}`);
      } catch (error) {
        lines.push(`chrome     ${error.message}`);
      }
      lines.push(`tools      ${TOOLS.map((tool) => tool.name).join(', ')}`);
      return lines.join('\n');
    },
  });

  // This package starts real browsers. A session that ends during a crawl would
  // leave one running and a profile directory on disk, so anything still open
  // when the host stops is closed here.
  pi.on('session_shutdown', async () => {
    const closed = await closeAllSessions();
    if (closed > 0) process.stderr.write(`design-os: closed ${closed} browser session(s) on shutdown\n`);
  });
}
