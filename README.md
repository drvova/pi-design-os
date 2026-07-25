# design-os

Explore dozens of design directions from your coding agent. Local-first.

A local-first rebuild of [Rivet](https://tryrivet.design) — same shape, no server-side
worker pool, no auth, no metering. Generation runs on the agent you already have.

Status: **empty repo.** Nothing is built. Four decisions below gate the first source file.

---

## What this is

An MCP server plus CLI that:

1. attaches to your project's existing dev server,
2. generates N design variants in parallel, each isolated,
3. shows them side by side in a local editor,
4. commits the one you pick back into your project.

## Prior art — Rivet, verified 2026-07-25

Rivet, Inc. — npm [`rivet-design`](https://www.npmjs.com/package/rivet-design) `0.14.11`,
135 releases since 2025-09-10, last publish 2026-07-24. Docs: <https://docs.rivet.design/mcp-guide>.

### Its MCP surface is three tools

| Tool | Purpose |
| --- | --- |
| `rivet_status` | Read-only session state, `workId`s, per-variant progress. ~10ms, poll-based, no blocking wait. |
| `rivet_variants` | `start` \| `complete` \| `commit` \| `cancel`. On `start`, the `briefs[]` array length sets the variant count. |
| `rivet_design_context` | URL to design context. Pinterest / Are.na route to account data; any other URL is rendered and screenshotted. |

### Its contract

Every control-plane subcommand prints exactly one JSON envelope on stdout; human-readable
progress goes to stderr. MCP tool results carry the same envelope verbatim.

```json
{ "schemaVersion": 1, "ok": true,  "command": "status", "data": {} }
{ "schemaVersion": 1, "ok": false, "command": "variants.start",
  "error": { "code": "AUTH_REQUIRED", "message": "Run `rivet login` first." } }
```

Exit codes: `0` ok, `1` operation failed, `2` usage error, `3` auth required,
`4` server unavailable, `5` wait timeout (not a failure).

### Its architecture, read off its dependency list

| Concern | Rivet |
| --- | --- |
| MCP | `@modelcontextprotocol/sdk`, stdio, `rivet mcp serve` |
| Dev-server proxy | `express` + `http-proxy-middleware`; user app `:3000`, editor `:4000` |
| Generation | server-side workers; `@anthropic-ai/claude-agent-sdk` present. Requires `rivet login` |
| Variant isolation | `simple-git`, `--no-git` opt-out |
| Queue | `redis` |
| Telemetry | `posthog-node`, `@sentry/node`, `--no-telemetry` opt-out |

Framework detection: Next.js, Vite, CRA, Remix, SvelteKit, Static HTML.
Fidelity tiers `low | medium | high` — high is "frontier-model authorship, up to a few minutes".

### What it does not do

- **No component extraction.** A variant is git-committed whole; there is no "copy the button out of direction 7".
- **No MCP Apps.** Directions render in a browser tab on `localhost:4000`, not inline in the chat host.
- **Not local.** Every variant is server-side inference behind a login.

## Where this repo diverges

| Rivet | design-os |
| --- | --- |
| Server-side worker pool, auth, billing | Local `@anthropic-ai/claude-agent-sdk` — no backend |
| `redis` queue | In-process. One process, one project. |
| `simple-git` branch per variant | `git worktree` per variant — N real dirs, N dev servers |
| Own render service for URL capture | `chrome-devtools-mcp`, already installed |
| Pinterest / Are.na OAuth | Local files plus URL capture |

The CLI contract and the three-tool MCP surface are worth copying as-is.

## Protocol notes

MCP Apps (`SEP-1865`, extension id `io.modelcontextprotocol/ui`) reached **stable `2026-01-26`**
— UI resources under `ui://`, mime `text/html;profile=mcp-app`, sandboxed iframe, host-enforced
CSP. Tools carrying `_meta.ui.visibility: ["app"]` are callable by the UI but hidden from the
model's tool list. Terminal hosts cannot render it, so a browser editor stays the primary
surface and MCP Apps is upside, not a dependency.

React 19 scores **100%** on [Custom Elements Everywhere](https://custom-elements-everywhere.com/)
(16/16 basic, 16/16 advanced, no open issues). Web components are no longer a tax in React.

CSS `@scope` is Baseline newly-available since December 2025, ~88% global. Safari 17.4+.

## Open decisions

Nothing gets written until these close.

1. **Isolation** — `git worktree` per variant (true parallel dev servers, N × `node_modules`)
   or in-place (one server, serial variants)?
2. **Editor stack** — does "native, DOM APIs, manifests" describe the editor itself, or only
   what it emits? These share zero files.
3. **Variant granularity** — whole-page, or component-scoped via CSS selector as the primary axis?
4. **Generation** — agent SDK per variant, or deterministic token permutation for color/type/
   spacing/radius with the model reserved for layout? This decides whether the tool costs $0.

Q4 is load-bearing. Deterministic permutation over a known token vocabulary renders instantly
and free; model authorship is minutes and metered.

## Requirements

Node >= 22.13.
