# design-os

Explore dozens of design directions from your coding agent. Local-first.

A local-first rebuild of [Rivet](https://tryrivet.design) — same shape, no server-side
worker pool, no auth, no metering.

Status: **direction engine and gallery work.** Project attachment, variant worktrees,
and the MCP server are not built yet.

---

## Usage

```bash
node bin/design-os.js directions --count 24 --seed monozukuri --open
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--count <n>` | `12` | directions to generate, 1-64 |
| `--seed <text>` | random | identical seeds reproduce identical output |
| `--polarity <p>` | `both` | `light`, `dark`, or `both` |
| `--out <path>` | `.design-os/directions.html` | gallery destination |
| `--open` | off | open the gallery in the browser |

One JSON envelope goes to stdout; progress goes to stderr.

```json
{ "schemaVersion": 1, "ok": true, "command": "directions",
  "data": { "count": 8, "seed": "showcase", "path": "…", "directions": [] } }
```

Exit codes: `0` ok, `1` operation failed, `2` usage error, `3` auth required,
`4` server unavailable, `5` wait timeout (not a failure).

## How the engine works

Generation is deterministic and free. A seed drives a PRNG; hues are spread **evenly**
around the wheel rather than sampled at random, which is what guarantees N directions
look meaningfully different rather than accidentally similar. Every other axis — tone,
shape, density, typeface, motion, polarity — is a seeded draw.

Colour is OKLCH, not HSL. Equal lightness steps are perceptually equal and hue stays
stable across the lightness range, so two directions at the same lightness carry the
same visual weight regardless of hue. Chroma at each scale step is a percentage of that
step's gamut maximum, so the ends of a ramp desaturate instead of clipping.

A direction is nothing but a set of CSS custom properties. Custom properties inherit,
so scoping them to a wrapper element isolates a preview with no iframe, no shadow root,
and no `@scope`. One stylesheet drives every preview in the gallery.

Copying reads the **authored** markup, never `innerHTML`. The DOM uncloses void elements
and expands `checked` to `checked=""`; both forms are invalid JSX.

```
src/oklch.js       colour maths, gamut boundary, 9-step scales
src/directions.js  seeded axis draws -> token sets
src/components.js  the component set and its stylesheet
src/jsx.js         HTML -> JSX attribute rewriting, shared with the page
src/gallery.js     one self-contained HTML document
src/envelope.js    wire contract and exit codes
bin/design-os.js   CLI
```

Zero runtime dependencies. `npm test` runs 15 checks on stdlib `node:test`.

## Prior art — Rivet, verified 2026-07-25

Rivet, Inc. — npm [`rivet-design`](https://www.npmjs.com/package/rivet-design) `0.14.11`,
135 releases since 2025-09-10, last publish 2026-07-24. Docs: <https://docs.rivet.design/mcp-guide>.

### Its MCP surface is three tools

| Tool | Purpose |
| --- | --- |
| `rivet_status` | Read-only session state, `workId`s, per-variant progress. ~10ms, poll-based, no blocking wait. |
| `rivet_variants` | `start` \| `complete` \| `commit` \| `cancel`. On `start`, the `briefs[]` array length sets the variant count. |
| `rivet_design_context` | URL to design context. Pinterest / Are.na route to account data; any other URL is rendered and screenshotted. |

### Its architecture, read off its dependency list

| Concern | Rivet | design-os |
| --- | --- | --- |
| MCP | `@modelcontextprotocol/sdk`, stdio | same, planned |
| Dev-server proxy | `express` + `http-proxy-middleware`, `:3000` to `:4000` | same, planned |
| Generation | server-side workers behind `rivet login` | deterministic locally; agent SDK only for layout |
| Variant isolation | `simple-git` branch per variant | `git worktree` per variant |
| Queue | `redis` | in-process |
| URL capture | own render service | `chrome-devtools-mcp` |
| Telemetry | `posthog-node`, `@sentry/node` | none |

Framework detection: Next.js, Vite, CRA, Remix, SvelteKit, Static HTML.
Fidelity tiers `low | medium | high` — high is "frontier-model authorship, up to a few minutes".

### What it does not do

- **No component extraction.** A variant is git-committed whole; there is no "copy the button out of direction 7".
- **No MCP Apps.** Directions render in a browser tab on `localhost:4000`, not inline in the chat host.
- **Not local.** Every variant is server-side inference behind a login.

## Protocol notes

MCP Apps (`SEP-1865`, extension id `io.modelcontextprotocol/ui`) reached **stable `2026-01-26`**
— UI resources under `ui://`, mime `text/html;profile=mcp-app`, sandboxed iframe, host-enforced
CSP. Tools carrying `_meta.ui.visibility: ["app"]` are callable by the UI but hidden from the
model's tool list. Terminal hosts cannot render it, so a browser gallery stays the primary
surface and MCP Apps is upside, not a dependency. The gallery is already a single
self-contained HTML document, which is exactly the shape a `ui://` resource takes.

React 19 scores **100%** on [Custom Elements Everywhere](https://custom-elements-everywhere.com/)
(16/16 basic, 16/16 advanced, no open issues). Web components are no longer a tax in React.

CSS `@scope` is Baseline newly-available since December 2025, ~88% global, Safari 17.4+.
Unused here — custom-property inheritance already isolates previews with less code.

## Decisions

1. **Isolation** — `git worktree` per variant. True parallel dev servers; cleanup is one command.
2. **Editor** — native. No framework, no build step, no runtime dependency.
3. **Granularity** — whole-page, with a CSS selector to scope a run to one element.
4. **Generation** — deterministic token permutation for colour, type, spacing, radius and
   motion. Model authorship is reserved for layout, where permutation cannot help.

Decision 4 is what makes a run instant and free where Rivet's is metered and takes minutes.

## Next

- `open` — framework detection, dev-server attach, proxy
- `variants start|status|commit` over `git worktree`
- `design-os mcp serve` — three tools over the same envelope

## Requirements

Node >= 22.13.
