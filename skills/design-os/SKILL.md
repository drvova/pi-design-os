---
name: design-os
description: Read a website's rendering pipeline and design, or clone it into a runnable local copy. Use when the user wants design inspiration from a site, asks how a site is built, asks which browser APIs or frameworks it uses, wants to know whether its styling is CSS or JavaScript, or asks to clone, copy, mirror or rebuild a site or its components.
---

# design-os

Three tools, all backed by one headless-Chrome load per route.

| Tool | Use when |
| --- | --- |
| `design_inspect` | "how is this site built", "what does it use", "read the design off this" |
| `design_clone` | "clone it", "copy it", "extract the components", "rebuild this" |
| `design_directions` | "give me design directions", "explore some palettes" |

## Reading a site

```
design_inspect { url: "stripe.com" }
```

Returns one envelope covering the whole page lifecycle. The sections that answer
most questions:

- `capture` — **read this first.** A degraded load still produces a full report,
  and a page whose scripts were blocked looks exactly like a static CSS page.
  If `degraded` is true, every other number describes a page that never
  finished loading. Say so rather than drawing conclusions from it.
- `styling.verdict` — `css`, `css-led`, `mixed` or `javascript`, from static
  declaration blocks against runtime style writes. A utility-CSS site lands near
  `css`; a CSS-in-JS site lands near `javascript`.
- `browserApis.called` — what the page reached for, how often, in which phase,
  and the millisecond of first use.
- `preDom` / `beforeDomContentLoaded` / `afterDomContentLoaded` — the three
  phases, taken from `document.readyState` rather than from bookkeeping.
- `direction` — the rendered design as tokens: palette in OKLCH, type scale,
  spacing, radius, motion. `observed.declaredTokens` holds the site's own
  custom properties where it publishes them.

Add `screenshot: true` for a PNG, `gallery: true` to render the extracted
direction as a previewable page.

## Cloning a site

```
design_clone { url: "emilkowal.ski", routes: 6, layout: "fsd" }
```

- `routes` above 1 crawls breadth-first from the url, following same-origin
  anchors in the rendered DOM. Start small: each route is a full browser load.
- `layout: "fsd"` writes a Feature-Sliced Design tree and extracts components
  into their own folders. `flat` mirrors the origin instead.
- Scripts are saved but disabled. The markup is the DOM after hydration, so
  live scripts would hydrate onto markup they did not build. Pass
  `scripts: true` only if the user asks for a running copy.

Verification runs by default: the copy is served over http, put through the
identical analysis, and scored against the original. Report `fidelity.score`
and `fidelity.lowest` — the average hides a single broken route.

Under `layout: "fsd"` each slice folder holds `ui/ui.html`, `ui/styles.css`
(**only** the rules that matched that subtree), `ui/preview.html` and a
`meta.json`. Check `meta.json.namedBy` before trusting a slice name: `tag` means
the markup offered nothing more specific, so describe it by what it is rather
than repeating an inferred name as fact.

## Reporting results

Quote the numbers the tools return rather than characterising them. `fidelity`,
`capture.degraded`, `assets.failed` and `clone.skipped` each carry a reason —
pass the reason through. A clone that skipped a cross-origin frame is a stated
limit, not a silent gap.

Do not reproduce a cloned site's text content back to the user. Report structure,
tokens, counts and file paths; the copy on disk is for inspection and rebuilding.

## Requirements

Chrome or Chromium. Set `CHROME_PATH` if it is not on the usual path. Node 22 or
newer, for the global `WebSocket` the CDP client uses.
