# design-os

Explore dozens of design directions from your coding agent. Local-first.

A local-first rebuild of [Rivet](https://tryrivet.design) — same shape, no server-side
worker pool, no auth, no metering.

Status: **direction engine, site inspection, gallery and MCP server work.** Project
attachment and variant worktrees are not built yet.

---

## Usage

```bash
node bin/design-os.js directions --count 24 --seed monozukuri --open
node bin/design-os.js inspect stripe.com --screenshot --gallery --open
node bin/design-os.js clone linear.app
node bin/design-os.js mcp
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--count <n>` | `12` | directions to generate, 1-64 |
| `--seed <text>` | random | identical seeds reproduce identical output |
| `--polarity <p>` | `both` | `light`, `dark`, or `both` |
| `--wait <ms>` | `15000` | ceiling on waiting for network idle |
| `--timeout <ms>` | `30000` | per-operation Chrome timeout |
| `--screenshot` | off | also write a PNG of the loaded page |
| `--gallery` | off | render the extracted direction as HTML |
| `--budget <mb>` | `40` | clone asset budget; the lowest priority is cut first |
| `--scripts` | off | keep the cloned page's scripts wired up |
| `--skip-verify` | off | do not load the clone back and score it |
| `--out <path>` | `.design-os/` | artefact destination |
| `--open` | off | open the result in the browser |

One JSON envelope goes to stdout; progress goes to stderr.

```json
{ "schemaVersion": 1, "ok": true, "command": "directions",
  "data": { "count": 8, "seed": "showcase", "path": "…", "directions": [] } }
```

Exit codes: `0` ok, `1` operation failed, `2` usage error, `3` auth required,
`4` server unavailable, `5` wait timeout (not a failure).

## What `inspect` reads

One navigation answers everything. Loading twice measures two different pages: caches
warm, A/B branches flip, and lazy work that ran the first time does not run the second.

Instrumentation is installed with `Page.addScriptToEvaluateOnNewDocument`, so it is in
place while `readyState` is still `loading` and before `document.body` exists. Wrapping an
API after the page's own scripts have run measures nothing. Every call is bucketed by
`readyState` at the moment it happens, which is the platform's own answer to "which phase
is this" and cannot drift from it.

| Phase | `readyState` | Reported as |
| --- | --- | --- |
| Parser running, no DOM yet | `loading` | `preDom`, `beforeDomContentLoaded` |
| DOMContentLoaded fired | `interactive` | `afterDomContentLoaded` |
| Load fired | `complete` | `afterDomContentLoaded` |

| Section | Answers |
| --- | --- |
| `preDom` | resource hints, render-blocking sheets, parser-blocking scripts, inline bytes — the authored head, in source order |
| `beforeDomContentLoaded` | requests, bytes, API calls and DOM mutations while the parser was still running |
| `afterDomContentLoaded` | hydration, lazy loading, and styling applied after the DOM existed |
| `assets` | every request in order, with type, initiator, protocol, bytes, cache state and phase |
| `browserApis` | which APIs were called, how often, in which phase, and at what millisecond first |
| `domMutations` | elements added and removed, attributes changed, text edits, split by phase |
| `styling` | static CSS counted against runtime style writes, with a verdict |
| `runtime` | lifecycle trace, listener types, layout shape, page errors |
| `direction` | the rendered design as a design-os direction, plus every raw reading |

The styling verdict is the split the question turns on. Stylesheet declaration blocks are
counted against runtime style writes: `css` under 5% dynamic, `css-led` under 30%, `mixed`
under 70%, `javascript` above it. A Tailwind site lands at `0.005`; a styled-components
site lands at `0.66`, because CSS-in-JS writes its rules through `insertRule` at runtime.

Design tokens are read out of stylesheet text rather than the CSSOM: `getComputedStyle`
does not enumerate custom properties in Chrome, and `cssRules` throws on a cross-origin
sheet. Names come from the text the CSS domain already returned, then each is resolved by
name against `:root`, so the value recorded is the one that applies after `var()`.

An inspected site comes back as a direction built by the same `tokensFor` that generated
directions use, so it renders in the same gallery and can be compared against them
directly. Snapping to shared axes is what makes a site comparable; the raw reading is
carried through untouched beside it, because that is what makes it truthful.

## What `clone` writes

`clone` runs the same single navigation `inspect` does and, before the session
closes, writes a runnable copy beside the report. Fetching the assets on a second
load would copy a page the report does not describe.

What gets localised is decided by the network log, not by parsing markup. The log
is the only record of what the browser actually fetched, so rewriting known urls
needs no HTML or CSS parser and cannot be defeated by an attribute syntax nobody
anticipated. A root-relative reference resolves against the origin of the file
holding it, so each stylesheet is rewritten against its own origin rather than
the page's — a font referenced as `/fonts/x.woff2` from a CDN stylesheet means
the CDN's root.

Three things have to be repaired on the way out, and each was found by loading a
clone back and watching it fail:

- **CSS that exists only in the CSSOM.** `insertRule` never touches the `<style>`
  element it belongs to, so serialization cannot see it. On a styled-components
  page that is the entire stylesheet — 1344 rules on `linear.app` — and the clone
  renders unstyled. Every inline sheet is written back to its owner, and
  constructed sheets held in `adoptedStyleSheets` are materialised into one.
- **The `<html>` element.** `Element.getHTML()` serializes children, the way
  `innerHTML` does, so shadow-aware serialization drops the root element. Its
  attributes are not decoration: `tailwindcss.com` defines `--font-inter` through
  a class on `<html>`, and without it every font falls back to system.
- **The origin's own policy.** A CSP naming the original's hosts blocks every
  local file, and an SRI hash fails the moment a reference is rewritten. Both are
  stripped, along with resource hints, which can only 404 against a clone.

Scripts are saved but disabled by default. A rendered DOM plus live scripts means
a framework hydrating onto markup it did not produce; `--scripts` keeps them if
that is what you want.

### Verification

A clone nobody loaded is a claim. Unless `--skip-verify` is passed, the copy is
served over http and put through the identical analysis, and the two designs are
scored against each other on surface, accent, palette, families, type scale,
radius, spacing, polarity and layout shape. Colours are compared perceptually in
OKLab: a clone can move a channel by one unit, and a score that calls `#08090a`
and `#090a0b` a total mismatch is measuring string equality, not fidelity.

| Site | Architecture | Fidelity | Files |
| --- | --- | --- | --- |
| `example.com` | static | 100% | 1 |
| `tailwindcss.com` | Next.js, utility CSS | 100% | 61 |
| `linear.app` | Next.js, styled-components | 100% | 402 |
| `vercel.com` | Next.js, Tailwind, CSS Modules | 100% | 94 |
| `stripe.com` | Next.js, CSS Modules | 100% | 98 |

### What a clone is not

- **One route.** Client-side routing is not crawled; the clone is the url given.
- **Cross-origin frames and workers.** They run in their own renderer, which a
  page-level session cannot read. Their addresses are kept as `data-design-os-src`
  and the frames emptied, because a frame left pointing at the origin fails on
  every future load. Each one is listed in `clone.skipped` with the reason.
- **Closed shadow roots.** Unreachable from script by design. Open roots are
  serialized as declarative `<template shadowrootmode>` and counted; hosts whose
  root could not be reached are counted separately.
- **Urls a script builds at runtime.** They never appear in the markup, so there
  is nothing to rewrite.

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
src/oklch.js       colour maths, gamut boundary, 9-step scales, sRGB -> OKLCH
src/directions.js  seeded axis draws -> token sets
src/components.js  the component set and its stylesheet
src/jsx.js         HTML -> JSX attribute rewriting, shared with the page
src/gallery.js     one self-contained HTML document
src/cdp.js         Chrome launch and DevTools Protocol client
src/probe.js       browser-side sources: pre-document probe, post-load harvest
src/inspect.js     one page load -> the whole pipeline
src/clone.js       localise, rewrite, serve, and score a copy
src/extract.js     rendered page -> design direction
src/commands.js    command implementations, shared by CLI and MCP
src/mcp.js         MCP stdio server
src/envelope.js    wire contract and exit codes
bin/design-os.js   CLI
```

Zero runtime dependencies. Node 22 ships a global `WebSocket`, so driving Chrome needs no
Puppeteer and no Playwright; `npm test` runs 31 checks on stdlib `node:test`, including a
full pipeline read off a local fixture served over `node:http` and a clone of a page whose
CSS exists only in the CSSOM.

## MCP

`design-os mcp` speaks line-delimited JSON-RPC 2.0 on stdio, protocol `2025-06-18`.

| Tool | Purpose |
| --- | --- |
| `design_inspect` | Load a url once and report its rendering pipeline and its design. |
| `design_clone` | Write a runnable local copy of a url, then load it back and score it. |
| `design_directions` | Generate deterministic directions and write a gallery. |

Both call `src/commands.js`, the same entry point the CLI uses, so a tool call and a shell
invocation cannot drift apart. Each result carries the CLI's envelope verbatim. The spec
requires that stdout carry MCP messages and nothing else, which is why the server never
calls `emit`; commands already send progress to stderr, so the message stream is safe by
construction. Work that fails comes back as a result with `isError` carrying the failure
envelope — protocol errors are reserved for messages the server could not understand.

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
| MCP | `@modelcontextprotocol/sdk`, stdio | own stdio server, no dependency |
| Dev-server proxy | `express` + `http-proxy-middleware`, `:3000` to `:4000` | same, planned |
| Generation | server-side workers behind `rivet login` | deterministic locally; agent SDK only for layout |
| Variant isolation | `simple-git` branch per variant | `git worktree` per variant |
| Queue | `redis` | in-process |
| URL capture | own render service | own CDP client over the Node 22 global `WebSocket` |
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

- `open` — dev-server attach and proxy
- `variants start|status|commit` over `git worktree`

## Requirements

Node >= 22.13, for the global `WebSocket`. `inspect` also needs Chrome or Chromium;
set `CHROME_PATH` if it is not on the usual path.
