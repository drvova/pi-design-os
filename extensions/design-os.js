/**
 * Pi extension.
 *
 * Pi loads this in its own process and calls `execute` directly, so there is no
 * subprocess, no JSON-RPC frame and no stdio contract between the agent and the
 * work. That removes the one hazard the MCP transport has to guard against: a
 * command writing to stdout can no longer corrupt a message stream, because
 * there is no message stream.
 *
 * The schemas come from `src/tools.js`, the same declaration the MCP server
 * serves, and every tool runs `src/commands.js`, the same entry point the CLI
 * uses. An agent therefore sees one tool whether it reached design-os natively,
 * over MCP, or through a shell.
 *
 * Paths stay relative, so artefacts land in `.design-os/` of whatever project
 * Pi is working in rather than inside this package.
 */

import { TOOLS, runTool } from '../src/tools.js';

/** Pi renders a tool result as text, so the envelope is serialised whole. */
const serialise = (envelope) => JSON.stringify(envelope, null, 2);

/**
 * Failure is reported by throwing, which is Pi's contract for a tool that did
 * not succeed. The wire code is kept in the message because it is the part a
 * caller can act on: `USAGE_ERROR` means fix the arguments, `SERVER_UNAVAILABLE`
 * means install Chrome.
 */
function reject(envelope) {
  const error = new Error(`${envelope.error.code}: ${envelope.error.message}`);
  error.code = envelope.error.code;
  return error;
}

export default function designOs(pi) {
  for (const tool of TOOLS) {
    pi.registerTool({
      name: tool.name,
      label: tool.title ?? tool.name,
      description: tool.description,
      parameters: tool.inputSchema,

      async execute(_toolCallId, params) {
        const envelope = await runTool(tool.name, params ?? {});
        if (!envelope.ok) throw reject(envelope);
        return serialise(envelope);
      },
    });
  }
}
