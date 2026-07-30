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
node bin/design-os.js clone linear.app --routes 5 --layout fsd
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
| `--routes <n>` | `1` | routes to crawl breadth-first from the url |
| `--layout <l>` | `flat` | `flat`, or `fsd` for a Feature-Sliced Design tree |
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

### Two modes

Scripts are saved but disabled by default. `--scripts` keeps them, and that
changes what a copy has to be, so it switches modes.

| | snapshot (default) | mirror (`--scripts`) |
| --- | --- | --- |
| markup | the DOM after hydration | the html the server sent |
| same-origin assets | filed under `shared/` or `assets/` | the pathname they were served from |
| references | rewritten to local files | same-origin left to resolve |
| canvas, animations, reveals | frozen into the markup | left to the scripts |
| opens from disk | yes | no, must be served |

Handing a framework the DOM its own hydration produced makes it tear the tree
down: emilkowal.ski collapsed from 85 elements to 12, unstyled, with 13 of 25
requests failing. And a chunk loader builds urls while it runs, so no rewriter
can ever see them — that page's markup holds 31 root-relative `/_next/` paths
and its scripts construct 12 more after load.

Both are answered the same way: serve the site its own shape. Mirror mode keeps
the served html, so hydration matches, and writes same-origin files at their
original pathname, so a root-relative url resolves whether it came from the
markup or from a script. Cross-origin assets are still filed and rewritten,
because nothing on this origin will ever construct those.

Mirrored, the same page loads with **0 of 24 requests failing**, 85 elements
against the original's 85, 19 browser APIs called against 19, 91 listener types,
and 102 post-DOMContentLoaded mutations. It is running, not just rendered.

Pick snapshot to study a design and mirror to keep a page working.

### What only an API could draw

In snapshot mode, disabling scripts takes the APIs with them, so anything painted
rather than declared would be lost. Four things are frozen while the page is
still live. Mirror mode skips all of it, because the scripts do it themselves:

- **Canvas and WebGL.** The last painted frame is read back and set as the
  element's own background, at the same size. A WebGL drawing buffer is cleared
  after compositing unless the context was asked to keep it, and that can only be
  set when the context is created — which is why the probe wraps `getContext`
  before any page script runs and forces `preserveDrawingBuffer`. A canvas that
  was never painted is skipped, since a blank frame would cover a background the
  stylesheet already provides.
- **`Element.animate`.** A script-driven animation never reaches the CSSOM, so
  each one is rewritten as the `@keyframes` and shorthand it is equivalent to. A
  `CSSAnimation` or `CSSTransition` already has a rule behind it and is left
  alone. An animation that has finished and is not filling has no state to keep.
- **Video.** The current frame becomes a `poster`, so a paused player shows the
  frame it was showing.
- **Anything waiting for a viewport.** The page is walked top to bottom before
  capture, then returned to the top, so `loading="lazy"` images load and reveal
  observers fire. Without it a clone copies the top of a page and leaves the rest
  as placeholders that will never fill, because the observers go with the scripts.

The walk runs **after** every measurement in the report and before the copy is
taken. Scrolling a page makes it do things, and those belong to the tool, not to
the site; the pipeline sections still describe the page's own behaviour.

### What still does not survive

A clone is a rendered state, not a running program. Event listeners are counted
but not wired, `fetch` results are frozen at capture, `matchMedia` and
`ResizeObserver` do not re-run at another size, workers and cross-origin frames
are unreachable, and closed shadow roots are unreachable by design. CSS keeps
working unaided: transitions, keyframes, `:hover`, media and container queries.

`fidelity` scores surface, palette, type, spacing and layout shape. Those are
design dimensions and they survive. **It measures nothing about behaviour** — a
score of 100% says the design carried over, not that the site works.

### Crawling a site

`--routes` above 1 walks the site breadth-first from the entry url. Destinations
come from anchors in the rendered DOM, read after hydration: they are what the
site itself offers, whatever framework built them, and finding them needs no
sitemap and no framework-specific knowledge. Breadth-first means a route cap
keeps the pages nearest the entry rather than whichever branch was walked first.

Every route is its own navigation, because a route can only be seen as the
browser builds it. One asset ledger is shared across them, so the second route
pays for nothing the first already saved — each route runs in a fresh browser
with a cold cache, and without the ledger a five-route clone of
`tailwindcss.com` would fetch the same 53 assets five times.

Links between routes are rewritten after the crawl, not during it. While the
first route is being captured there is no way to know which of its destinations
will end up cloned, so a link can only be pointed at a file once the set of
routes is closed.

A url reference is matched as a whole delimited token, never as a substring.
That rule is what the crawl turns on, and it is easy to get wrong in two ways at
once:

- The entry url is a prefix of every absolute url on its own site, so a
  substring match rewrites the front of `https://x.com/plus` and leaves
  `./index.htmlplus`.
- A cloned route prefixes the uncloned pages beneath it. `/docs` sits inside
  `/docs/installation`, and there is no longer alternative to prefer because
  that page was never cloned.

Matching must also be a single pass. Replacing in sequence is unsafe in both
directions: the short url first splices its path into the middle of the long
one, and the long url first leaves `./docs/install/index.html`, which the short
url then matches inside the result just written. A fragment or a query may
follow a match, since both address the same document; a path separator may not.

Anchors are counted honestly after the pass. `unresolved` is a destination still
addressing the site — a page the crawl did not reach, whether it was over the
route cap or refused as a non-document. Cloning 5 of the 311 routes
`tailwindcss.com` offers leaves most links with nowhere local to go, and the
number says so.

### Feature-Sliced output

`--layout fsd` writes the clone as a [Feature-Sliced Design](https://feature-sliced.design)
tree instead of a mirror of the origin. `app` and `shared` hold segments directly,
because neither has business domains; every other layer holds slices, each with a
`ui` segment.

```
index.html            pointer into pages/, so the folder still opens
app/styles/           tokens.css, fonts.css, global.css
pages/<route>/ui/     one slice per cloned route
widgets/<name>/ui/    landmarks: header, footer, nav, aside
features/<name>/ui/   declared interaction: forms, dialogs, menus
entities/<name>/ui/   subtrees the page repeats
shared/ui/<name>/     leaf controls, one folder per distinct control
shared/vendor/        the site's own stylesheets and scripts, verbatim
shared/fonts/  shared/images/  shared/media/
manifest.json  README.md
```

Each slice folder carries `ui/ui.html`, `ui/styles.css`, `ui/preview.html` and a
`meta.json`.

**The stylesheet beside a component is only that component's.** The browser's own
selector engine decides what applies: every rule is tested once, and each match
is walked up to the slices that contain it, so a button inside a header belongs
to the button's folder and to the header's. Rules that address the document are
held back, because a universal selector matches every node and Tailwind's
preflight would otherwise be copied under all seventy-odd components with no
single home.

A rule written for a state the page is not in is still that component's rule. A
menu styled through `[aria-expanded="true"]` matches nothing while it is closed,
so those rules never reached it — `lawsofux.com` styles its toggle icons that way
and lost four of them. Interactive state attributes are therefore removed before
matching, the same way `:hover` already was, which brings 30 state selectors into
that site's ten slice stylesheets.

Only attributes that express a toggle: `aria-expanded`, `aria-selected`,
`aria-checked`, `aria-pressed`, `aria-current`, `data-state` and its neighbours,
and a bare `open`. `aria-hidden` and `aria-disabled` are deliberately left in
place, because widening those selectors reaches content the component does not
own and would attribute rules to slices with nothing to do with them.

Asking the CSS domain per node is equally exact and costs a round trip each,
which measured 80ms on `tailwindcss.com`: fifty slices of a few hundred nodes is
twenty thousand calls and twenty-six minutes of waiting that is indistinguishable
from a hang. Inverting it is one message, no node is sampled away, and the same
page finishes in 24 seconds.

`preview.html` reproduces the captured `html` and `body` attributes. Those are
not decoration: a theme class sits on `html` and font-loader classes sit on
`body`, and a preview with a bare shell renders every component in the fallback
serif with none of its tokens resolved.

### Naming a slice

A cloned page has no business domains, so a name is inferred and the source is
recorded in `meta.json` — `namedBy: "tag"` means nothing better was available.

| Source | Example |
| --- | --- |
| `source` | the author's own component name, from `element-source` |
| `id` | `form#subscribe` becomes `features/subscribe-form` |
| `aria-label` | a labelled control becomes `shared/ui/play-video-button` |
| `class` | `PostCard_root__c3d4` becomes `entities/post-card` |
| `content` | a nested landmark takes its own heading |
| `tag` | `header` becomes `widgets/site-header` |

An id or a label names the instance, so the tag is appended to say what the thing
is. A class only counts when it is the author's own name: a utility class
describes appearance, not identity, and naming a component after one produces
`widgets/mb-32` for a page header. Utilities are rejected by a prefix vocabulary,
since a shape test separates `mb-32` from `post-card` but not `items-center` from
it — both are two words, and only the first names a CSS property. An element
carrying five or more classes is being styled by utilities and is not named from
them at all. Framework-generated ids are rejected too, because they change
between renders.

A primitive is named for what it is for and never for how it is styled, so a
button is its label or just `button`. A repeated subtree needs three descendants
to count as an entity, or a page of paragraphs becomes a page of components.

### Names the author wrote

[`element-source`](https://www.element-source.com) reads a component's own name
and source file out of framework internals, for React, Preact, Vue, Svelte and
Solid. Where it answers, it wins: a folder called `card` with
`sourceFile: "/src/Card.jsx:3"` in its `meta.json` beats anything inferred from
markup, and `componentStack` records the components it sits inside.

It is an **optional** dependency, and absent is the normal case. It reads
metadata that a production build strips, so on a third-party site it returns
nothing: measured across `emilkowal.ski`, `vuejs.org`, `svelte.dev` and
`linear.app` — 3042 live React fibers between them — it resolved zero names and
zero paths, because those fibers carry neither `_debugSource` nor `_debugOwner`.
A dev server is the opposite. Pointed at a Vite React app it resolves `Card` at
`/src/Card.jsx:3`, which is the case that matters for cloning your own work.

Injecting it changes nothing about the capture: the same page cloned with the
library present and parked produced identical fidelity, slice count and element
count. With nothing installed the inferred chain applies unchanged, so design-os
still runs with no dependencies at all — installing this one pulls `bippy` with
it, which is the whole reason it is optional rather than required.

### Colour schemes

A site with a theme toggle has a second design, and a single capture never sees
it. `--modes dark` reads the design again in that scheme.

```
design_clone { url: "lawsofux.com", modes: ["dark"] }
```

Two mechanisms, because one is not enough. `prefers-color-scheme` is emulated
first, since it touches nothing on the page. A site that ignores it and keys
theme off its own attribute is then asked through its own control — the button
whose accessible name is about theme — and `lawsofux.com` is exactly that case:
it reports the dark preference as matching and stays resolutely light until its
own toggle is used.

**A variant is only reported once the page is shown to have changed**, and change
is judged by appearance alone, never by attributes on the root. Asking a page to
go dark can set an attribute this tool put there itself; counting that as proof
reported a variant on a fixture that had none. A site with one appearance and no
way to change it says so:

```json
{ "mode": "dark", "changed": false,
  "reason": "the page looks the same after asking, so it has no such variant" }
```

The tokens land in `app/styles/tokens.dark.css`, scoped by whatever actually
selects that scheme — read off the root the page set rather than assumed:

```css
/* dark tokens — 63 values, active when :root[data-color-mode="dark"] applies */
/* reached by control: Dark Mode Light Mode */
:root[data-color-mode="dark"] { … }
```

A site that only answers the media query gets a `@media` wrapper instead.

Reading a variant is the **last** thing a capture does. A clicked toggle does not
come back when the emulated media query is cleared, so the copy, the slices and
the screenshot are all taken in the state the page arrived in, and only then is
the theme changed.

Languages are usually separate routes — `lawsofux.com` links `/es/` and `/fr/` —
so `--routes` reaches them like any other page, in breadth-first order. A
language chosen from a dropdown that never changes the url is not reachable this
way, and neither is a menu that has to be opened: those are interaction, not a
second design.

### Cloning a list

```
design_batch { from: "sites.txt", routes: 2, layout: "fsd" }
```

One url or hostname per line, `#` starts a comment, duplicates are collapsed —
a browser launch per repeated host is minutes spent for nothing. Every option
`design_clone` takes applies to each target.

Sequential on purpose. Each clone drives its own browser, and running several at
once is what left stray Chrome profiles behind during development; a steady pass
finishes sooner than a contended one and is far easier to reason about when a
single site misbehaves.

Two properties matter more than speed for a run measured in hours:

- **A failure is recorded, not raised.** One unreachable host must not discard
  the fifty clones before it. Its row carries the wire code and the message.
- **The ledger is written after every target.** A run that is interrupted resumes
  where it stopped. Re-running is a resume: what succeeded is skipped, what failed
  is tried again, since a failure is usually the network rather than the target.
  `retry` re-clones everything.

```
[1/2] example.com
[2/2] ftp://not-a-website — failed: only http and https are supported, got ftp:
1 cloned, 0 already done, 1 failed — ledger at .design-os/batch-sites.json
```

The returned rows are summaries — fidelity, routes, slices, assets, the clone and
report paths. The full report for each target is on disk.

### A clone you can edit

Every clone is written as a project: a `package.json` and a Vite config beside the
markup, so it opens in a dev server that reloads a page when you edit its css.

```sh
npm install && npm run dev      # or: bun install && bun run dev
npm run build                   # bundles every page into dist/
```

Nothing about the copy needs it — the pages are static and open from disk, and
`design-os serve` still needs no install. The project is there for the loop:
edit, see it, build it out.

Every cloned route is a build entry, because a multi-page site has no single
entry to infer, and a route reached from two pages is collapsed to one so the
same file is not built twice. `appType: 'mpa'` is set deliberately: without it a
missing page falls back to the entry, which hides a broken link rather than
showing it. Slice previews are served in dev but are not build entries.

This was measured before it was offered, on a three-route clone of svelte.dev.
Served as plain files, served by the dev server, and served from `dist` after a
build all score a fidelity of **1** against each other, with no weakest check —
so neither the dev server nor the bundler changes what renders. The build emitted
all four pages in 204ms.

Vite is declared as the clone's dependency, never design-os's, so cloning
installs nothing. `--no-vite` skips the two files.

A mirror clone declines the project instead of half-serving it: a mirror runs the
site's own scripts, and a dev server would try to rebuild a production bundle it
did not produce, on urls that loader constructs at runtime. Serve a mirror over
http instead — that is what makes it work.

### One at a time, and only work that fits

Three guards, each of which exists because its absence caused a real failure.

**Only one browser-driving command runs at a time.** A transport with a request
timeout abandons a call that runs long; the work does not stop, and a caller that
retries then has two of these running at once, each launching its own browser.
That is how a stack of timed-out clones became unresponsive Chrome processes. A
second caller is refused immediately with what is already running, rather than
queued — a caller that has timed out once should not be made to wait again.

**Work that cannot finish in the caller's window is refused before a browser
starts.** A tool call carries a deadline; a terminal does not. Two-route clones of
the sites above finished in 24 to 37 seconds, so thirty seconds a route is the
estimate, and anything beyond the caller's budget is refused with the alternative
named: fewer routes, `skipVerify`, or the CLI where nothing times out.

**A batch is bounded, not refused.** Its ledger already makes a second call a
resume, so it does as many targets as fit and returns `incomplete` with
`continueBy`. Refusing it outright made the feature unreachable from the surface
it was built for.

**A browser abandoned by a killed launcher is cleared before the next one starts.**
A session closed normally takes its browser and profile with it; a launcher killed
outright does not, and the browser is reparented and keeps running. Each profile
records the pid that created it, so abandonment is exact — parentage is not a
usable signal, because a killed process's children go to whatever subreaper the
session has rather than to init. A profile whose launcher is still alive belongs to
another design-os and is left strictly alone.

### Reaching a clone without a shell

Cloning is half the job: a clone has to be looked at and read from, and both were
shell work until they were tools.

```
design_clone  { url: "emilkowal.ski", layout: "fsd" }
design_slices { dir: "emilkowal.ski" }                     every slice, by layer
design_slices { dir: "emilkowal.ski", name: "site-header" } markup + its own css
design_serve  { dir: "emilkowal.ski" }                     http://127.0.0.1:37007/
design_serve  { stop: true }                               closes every one
```

Either takes a directory or the site the clone came from, so `emilkowal.ski` finds
what `design_clone` wrote without the caller having to know the naming rule; when
it finds nothing it names the clones that do exist rather than only saying no.

A server is **registered, not spawned and forgotten**. Asking twice for the same
clone returns the same url instead of a second port, `stop` closes one, and
`session_shutdown` closes every one alongside the browsers. That guard is not
speculative: two throwaway static servers written during development each outlived
the wrapper that reported them stopped, and each held a port until it was hunted
down by pid — the same failure `src/cdp.js` keeps a session registry to avoid.

The CLI has the same commands, and `design-os serve` waits rather than exiting,
because a served clone lives exactly as long as its process.

### Verification

A clone nobody loaded is a claim. Unless `--skip-verify` is passed, the copy is
served over http and put through the identical analysis, and the two designs are
scored against each other on surface, accent, palette, families, type scale,
radius, spacing, polarity and layout shape. Colours are compared perceptually in
OKLab: a clone can move a channel by one unit, and a score that calls `#08090a`
and `#090a0b` a total mismatch is measuring string equality, not fidelity.

Every cloned route is scored, not just the entry. The manifest reports the mean
and the lowest, because an average hides a single broken route and the worst one
does not.

Nothing in the cloning path branches on a framework: the transport is CDP, the
phases come from `readyState`, assets come from the network log, and slices come
from the DOM. The verification, though, was almost all Next.js, which is a gap in
the evidence rather than in the code — and widening it immediately found a bug
that had nothing to do with Next.

| Site | Architecture | Routes | Fidelity | Unique assets |
| --- | --- | --- | --- | --- |
| `example.com` | static | 1 of 1 | 100% | 0 |
| `stripe.com` | Next.js, CSS Modules | 1 of 112 | 100% | 98 |
| `tailwindcss.com` | Next.js, utility CSS | 5 of 311 | 100% | 109 |
| `linear.app` | Next.js, styled-components | 3 of 81 | 100% | 411 |
| `vercel.com` | Next.js, Tailwind, CSS Modules | 3 of 79 | 100% | 146 |
| `astro.build` | Astro islands, Tailwind | 2 | 100% | 23 |
| `vuejs.org` | Vue, VitePress | 2 | 100% | 69 |
| `htmx.org` | HTMX, no build step | 2 | 100% | 49 |

Seven of those eight score **exactly 1.0 on every check**, as do `notion.com`,
`framer.com`, `cal.com` and `emilkowal.ski`.

`stripe.com` sits at 0.998, and the reason is now measured rather than guessed:
its homepage never reaches a still state. Waiting for its animations timed out at
six seconds and the number of running animations was *higher* after the wait than
before it — 88 against 87 — so it is generating them continuously. Two of its 76
grid containers are therefore always caught in a different pose between two
readings, and no amount of waiting closes that. `grids` and `flexes` could be
dropped from the score to make it read 1.0, and are not: unlike a `link`, a grid
container is structure, and a check that would catch a missing one is worth more
than a round number.
| `svelte.dev` | SvelteKit | 2 | 100% | 53 |

Eight stacks, every one at 100%, each under 40 seconds with `--layout fsd`.

### Scoring like against like

A copy is taken after the page has been walked, so it holds lazy content the
first reading never saw. Scored against that first reading it loses marks for
being the more complete of the two — stripe.com came out at 65% on element count
while its own two consecutive loads agreed to the element. The design is
therefore read a second time after the walk, purely for scoring; every number in
the pipeline report still comes from the reading taken before it.

Three further asymmetries had to go before the scores settled, all of the same
shape: the two sides were being measured differently and the copy was charged for
it.

- **The second reading is the last thing before serialization.** Taken any
  earlier it describes a smaller page than the one written, because a site keeps
  mounting while slices are detected and matched.
- **The copy is walked too.** Verification used to load it and read it without
  the walk, scoring a pre-walk reading against a post-walk one.
- **Link elements are not structure.** A page can inject dozens into its body
  while it runs — notion.com adds eighteen — and a copy with its scripts disabled
  can never have them. A `link` renders nothing, so counting one measures loading
  metadata rather than structure, and none of them count on either side.
- **The page is allowed to stop moving first.** `document.getAnimations` reports
  CSS animations, transitions and Web Animations together, and each carries a
  `finished` promise. Awaiting the finite ones, then two frames, turns two
  photographs of a moving page into two readings of the same pose. Anything set
  to run forever is left alone, because a spinner is not something to wait for,
  and a cancelled animation rejects rather than resolving, which is ordinary
  while a page settles and is caught per animation instead of failing the batch.

### What a clone is not

- **Only what is linked.** Routes come from anchors, so a page reachable only by
  a form, a script-driven navigation or a login is never found. The crawl also
  refuses anything that is not a document: a linked pdf keeps its address and is
  counted as unresolved.
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
src/crawl.js       breadth-first multi-route cloning
src/slices.js      slice detection, matched css, Feature-Sliced output
src/extract.js     rendered page -> design direction
src/commands.js    command implementations, shared by CLI and MCP
src/mcp.js         MCP stdio server
src/tools.js       the tool surface, declared once for both front ends
src/envelope.js    wire contract and exit codes
bin/design-os.js   CLI
extensions/        the Pi extension, loaded in-process
skills/            when the agent should reach for each tool
```

No required dependencies; `element-source` is optional and only for naming slices after
their real source files. Node 22 ships a global `WebSocket`, so driving Chrome needs no
Puppeteer and no Playwright; `npm test` runs 63 checks on stdlib `node:test`, including a
full pipeline read off a local fixture served over `node:http`, a clone of a page whose CSS
exists only in the CSSOM, a four-route crawl whose every rewritten link is fetched back
through the served copy, and a Feature-Sliced run asserting that a slice carries the rules
that matched it and none that did not. Total: 74 checks, including one that asserts the native and MCP surfaces are the same
object rather than two copies of it, one that asserts a degraded capture is drawn above the
verdict it invalidates, and one that asserts the two front ends never offer the same tool
twice. The extension takes its config paths as an argument, so what a machine happens to
have installed cannot decide what the tests see.

## Pi

design-os is a Pi package. `package.json` points Pi at an extension and a skill:

```json
"pi": {
  "extensions": ["./extensions/design-os.js"],
  "skills": ["./skills"]
}
```

Pi loads the extension in its own process and calls each tool directly, so there
is no subprocess, no JSON-RPC frame and no stdio contract between the agent and
the work. That removes the one hazard the MCP transport must guard against: a
command writing to stdout cannot corrupt a message stream when there is no
message stream. Failure is reported by throwing, which is Pi's contract, with the
envelope's wire code kept in the message because that is the part a caller can
act on.

```bash
pi install git:github.com/drvova/pi-design-os
pi remove git:github.com/drvova/pi-design-os   # reversible
```

Four things make the package native rather than merely reachable.

**Tools.** `design_inspect`, `design_clone` and `design_directions`, registered
from the shared declaration — unless the same server is already configured in
`mcp.json`, in which case they are left to it. See below.

**Commands**, so the work can be run without spending a model turn:

| Command | |
| --- | --- |
| `/design-inspect <url>` | read a url's pipeline and design |
| `/design-clone <url> [routes] [fsd\|flat]` | clone or crawl a site |
| `/design-directions [count] [seed]` | generate directions |
| `/design-doctor` | check node, the global `WebSocket`, and the Chrome binary |

Pi has passed command arguments as `(args, ctx)` and as `(ctx)` across versions,
so both shapes are accepted rather than one being assumed.

**Renderers.** A clone report is hundreds of kilobytes of JSON, so the tool draws
six lines instead: routes, slices, links, fidelity, artefact paths. A degraded
capture is printed first, above the styling verdict, because a page whose scripts
were blocked looks exactly like a static CSS page and the warning cannot sit
below the number it invalidates. The renderer degrades to Pi's own output rather
than throwing when given anything it does not recognise.

**A shutdown hook.** This package starts real browsers. `src/cdp.js` keeps a
registry of open sessions, and `session_shutdown` closes any that survive, so a
Pi session ending mid-crawl cannot leave Chrome running and a profile directory
on disk.

The skill in `skills/design-os` tells the agent when to reach for each tool, and
which fields to read first — `capture.degraded` before any conclusion drawn from
a report, and `meta.json.namedBy` before repeating an inferred slice name as
fact.

## MCP

`design-os-mcp` is the server as an `mcp.json` client launches it — a dedicated
binary, so the entry is a command with no arguments and cannot be broken by a
change to the CLI's argument parsing. `design-os mcp` is the same server reached
the other way. It speaks line-delimited JSON-RPC 2.0 on stdio, protocol
`2025-06-18`.

```json
{
  "mcpServers": {
    "design-os": { "command": "design-os-mcp", "args": [] }
  }
}
```

`examples/mcp.json` holds that, and `examples/mcp.local.json` the absolute-path
form for a checkout that is not installed. Pi reads `~/.pi/agent/mcp.json`; other
clients read their own file with the same shape.

### Only one of the two paths at a time

The package can be reached natively and over MCP, and both at once is the single
combination that is wrong: Pi would spawn the stdio server, register its tools,
and the extension would then register a second set under the same names. The
model would see every tool twice.

The extension is the one that yields, because it cannot unregister what MCP
supplied. On load it reads the MCP config, and if design-os is there and enabled
it skips tool registration and says so, naming the file so the entry can be
found. Commands and the shutdown hook are registered either way — MCP has no way
to offer a slash command, and no way to close a browser this package started.

`/design-doctor` reports which path is live.

| Tool | Purpose |
| --- | --- |
| `design_inspect` | Load a url once and report its rendering pipeline and its design. |
| `design_batch` | Clone every target in a list file, resumably. |
| `design_serve` | Serve a clone and return its url. Registered, reused, closable. |
| `design_slices` | List the components a clone extracted, or return one in full. |
| `design_clone` | Copy a url, or crawl a site, then load every route back and score it. `layout: "fsd"` emits a Feature-Sliced tree with components extracted. |
| `design_directions` | Generate deterministic directions and write a gallery. |

Both front ends read one declaration in `src/tools.js` and run `src/commands.js`, the same
entry point the CLI uses, so a tool call, a native call and a shell invocation cannot drift
apart: a schema written twice would let an agent see a different tool depending on how it
reached the same code. Each result carries the CLI's envelope verbatim. The spec
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
- slice detection for frameworks that keep component names in the build
- `variants start|status|commit` over `git worktree`

## Requirements

Node >= 22.13, for the global `WebSocket`. `inspect` also needs Chrome or Chromium;
set `CHROME_PATH` if it is not on the usual path.
