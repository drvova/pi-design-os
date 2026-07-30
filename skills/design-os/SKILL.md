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
| `design_batch` | "clone all of these", "run it over this list", a file of sites |
| `design_serve` | "let me see it", "open the clone", "show me in the browser" |
| `design_slices` | "what components did it find", "show me the button", "that card's css" |
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
- `scripts: false` (default) is **snapshot** mode: the DOM after hydration, with
  canvas frames, script-driven animations and lazy content frozen into the
  markup. Opens straight from disk. Use it to study a design.
- `scripts: true` is **mirror** mode: the html the server sent, with same-origin
  files at their original pathname so runtime-built urls resolve. The page runs.
  It must be served over http, not opened from disk. Use it when the user wants
  a working copy rather than a readable one.

Verification runs by default: the copy is served over http, put through the
identical analysis, and scored against the original. Report `fidelity.score`
and `fidelity.lowest` — the average hides a single broken route.

If `meta.json` carries a `sourceFile`, the slice is named after the author's own
component and that path is where it is defined — say so rather than describing it.
That only resolves against a dev server; a production build strips the metadata,
so its absence is normal and not a failure to report.

Under `layout: "fsd"` each slice folder holds `ui/ui.html`, `ui/styles.css`
(**only** the rules that matched that subtree), `ui/preview.html` and a
`meta.json`. Check `meta.json.namedBy` before trusting a slice name: `tag` means
the markup offered nothing more specific, so describe it by what it is rather
than repeating an inferred name as fact.

## Colour schemes

A site with a theme toggle has a second design. Pass `modes: ["dark"]` to
`design_inspect` or `design_clone` to read it.

Check `changed` on each variant before reporting one. `false` means the page has
no such scheme, and `activatedBy` says how it was reached — `prefers-color-scheme`
for a site that respects the media query, `control: <name>` for one driven by its
own button. Report the variant's own surface and accent rather than implying the
base colours apply to it.

The copy itself stays in the state the page arrived in; a variant is a second
reading of the design, not a second clone.

Languages are usually separate routes, so `routes` reaches them. A language or
menu that only changes state without changing the url is not captured — say so
rather than implying it was.

## Cloning many sites

For more than a handful, write the targets to a file and use `design_batch`
rather than calling `design_clone` in a loop: it records progress after every
target, so an interrupted run resumes instead of starting again.

Report `cloned`, `skipped` and `failed` separately, and pass through the reason
on any failed row. A second call on the same list is a resume, not a repeat.

Warn the user about the cost before starting a long one: each target is a real
browser load, so roughly 20 to 40 seconds per site, sequentially.

## After a clone

Do not shell out to read or serve a clone; both are tools.

```
design_slices { dir: "stripe.com" }                       list every slice by layer
design_slices { dir: "stripe.com", name: "site-header" }  markup + only its own css
design_serve  { dir: "stripe.com" }                       returns a url to open
design_serve  { stop: true }                              closes every server
```

Both accept the site name as well as a path. `design_serve` reuses an existing
server rather than opening a second port, and every server closes on session
shutdown — but close one yourself when finished rather than leaving it holding a
port for the rest of the session.

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
