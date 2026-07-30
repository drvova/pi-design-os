/**
 * Feature-Sliced Design output for a clone.
 *
 * A cloned page has no business domains, so the slice names come from what the
 * markup states rather than from what it looks like: an id, an aria-label, the
 * author's own CSS-module name, or the tag. Every slice records which of those
 * named it, so a guess can be checked instead of trusted.
 *
 * The CSS for a slice is resolved through `CSS.getMatchedStylesForNode`, one
 * node at a time. That is the browser answering which rules apply, so the
 * stylesheet beside a component is exactly its own — not a selector search, and
 * not the whole sheet copied next to every fragment.
 *
 * Layers follow the specification: `app` and `shared` hold segments directly
 * because neither has business domains, and every other layer holds slices,
 * each with a `ui` segment.
 */

import { readFile } from 'node:fs/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { localise } from './clone.js';
import { MATCH_SLICES, SLICES, SOURCE_NAMES } from './probe.js';

/**
 * The browser build of `element-source`, if it is installed.
 *
 * Optional on purpose. It resolves a component's own name and source file from
 * framework internals, which is a better name for a folder than anything markup
 * can imply — and a production bundle strips the metadata it reads, so it
 * returns nothing on a third-party site. design-os therefore keeps working with
 * nothing installed and gains real names when pointed at a dev server.
 */
async function sourceLibrary() {
  try {
    // The package exports only its own entry, so the browser build cannot be
    // imported by subpath. Resolve the entry and read the sibling file instead.
    const entry = createRequire(import.meta.url).resolve('element-source');
    return await readFile(join(dirname(entry), 'index.global.js'), 'utf8');
  } catch {
    // Not installed, or published without the global build. Neither is a fault.
    return null;
  }
}

/** Filesystem-safe kebab form of a component name. */
const kebab = (text) =>
  String(text)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

/**
 * Asks the page what the author called each slice.
 *
 * Runs after detection, because it keys off the markers detection leaves behind.
 */
async function sourceNames(session) {
  const library = await sourceLibrary();
  if (!library) return { available: false, names: {} };

  const injected = await session.send('Runtime.evaluate', { expression: library }).catch(() => null);
  if (!injected || injected.exceptionDetails) return { available: false, names: {} };

  const resolved = await session
    .send('Runtime.evaluate', { expression: SOURCE_NAMES, returnByValue: true, awaitPromise: true })
    .catch(() => null);
  return resolved && !resolved.exceptionDetails ? resolved.result.value : { available: false, names: {} };
}

const MARKER = 'data-design-os-slice';

/** `shared` holds segments directly, so its slices live under the `ui` segment. */
export const markerToDir = (marker) => (marker.startsWith('shared/') ? `shared/ui/${marker.slice(7)}` : marker);

async function write(root, relative, contents) {
  const target = join(root, ...relative.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, 'utf8');
  return relative;
}

/** Declarations for one rule, wrapped in whatever conditions it sits under. */
function declaration({ selector, body, conditions }) {
  const block = `${selector} {\n  ${body.trim().replace(/;\s*/g, ';\n  ').trim()}\n}`;
  return conditions.reduceRight(
    (inner, condition) =>
      `${condition.startsWith('@') ? condition : `@media ${condition}`} {\n${inner.replace(/^/gm, '  ')}\n}`,
    block,
  );
}

/** Rules to a stylesheet, with the custom properties they reach for. */
function stylesheet(rules = []) {
  const css = rules.map(declaration).join('\n\n');
  return {
    css,
    rules: rules.length,
    variables: [...new Set([...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]))].sort(),
  };
}

/**
 * Detects slices and resolves the css for each, against the live document.
 *
 * This has to run before the page is serialized: detection marks the nodes, and
 * a selector can only be tested against a document that still exists. Writing
 * happens later, once the asset map is known and references can be rewritten.
 */
export async function collectSlices(session) {
  const result = await session.send('Runtime.evaluate', { expression: SLICES, returnByValue: true });
  if (result.exceptionDetails) throw new Error(`slice detection failed: ${result.exceptionDetails.text}`);

  const { shell = { html: {}, body: {} }, slices = [] } = result.result.value ?? {};
  const detected = slices.filter((slice) => slice.html);
  if (detected.length === 0) return { shell, slices: [] };

  // One evaluation for every slice at once.
  //
  // Asking the CSS domain which rules match a node is exact, and it costs a
  // round trip per node: measured at 80ms on a page of this size, fifty slices
  // of a few hundred nodes each is twenty thousand calls and twenty-six minutes
  // of waiting that is indistinguishable from a hang. Inverted, the browser's
  // own selector engine answers once per rule, no node is sampled away, and the
  // whole thing is one message.
  const matched = await session.send('Runtime.evaluate', { expression: MATCH_SLICES, returnByValue: true });
  if (matched.exceptionDetails) throw new Error(`slice matching failed: ${matched.exceptionDetails.text}`);

  const { slices: perSlice = {}, shell: shellRules = [], rulesConsidered = 0 } = matched.result.value ?? {};

  // A name the author wrote beats a name inferred from markup, so it replaces
  // the detector's choice where it exists. Everything else is left alone: on a
  // production site this resolves nothing and the inferred chain still applies.
  const source = await sourceNames(session);

  return {
    shell: { ...shell, ...stylesheet(shellRules) },
    rulesConsidered,
    source: { available: Boolean(source.available), named: source.named ?? 0, of: source.total ?? detected.length },
    slices: detected.map((slice) => {
      const authored = source.names?.[slice.marker];
      const named = authored?.componentName ? { base: kebab(authored.componentName), namedBy: 'source' } : {};
      return {
        ...slice,
        ...stylesheet(perSlice[slice.marker]),
        ...named,
        sourceFile: authored?.filePath
          ? `${authored.filePath}${authored.lineNumber ? `:${authored.lineNumber}` : ''}`
          : null,
        componentStack: authored?.stack ?? null,
      };
    }),
  };
}


/**
 * Splits the site's stylesheets into the three things an app layer owns.
 *
 * Tokens, faces and resets are global by definition; leaving them inside a
 * component's stylesheet would repeat them under every slice and hide where
 * they are actually declared.
 */
export function splitAppStyles(sheetTexts) {
  const fonts = [];
  const tokens = [];
  const globals = [];

  for (const text of sheetTexts) {
    let depth = 0;
    let start = 0;

    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (character === '{') {
        if (depth === 0) start = index;
        depth += 1;
      } else if (character === '}') {
        depth -= 1;
        if (depth !== 0) continue;

        const block = text.slice(start, index + 1);
        const prelude = text.slice(0, start).split(/[}]/).pop().trim();
        const rule = `${prelude} ${block}`;

        if (/^@font-face/i.test(prelude)) fonts.push(rule);
        else if (/(^|,)\s*(:root|html)\b/.test(prelude) && block.includes('--')) tokens.push(rule);
        else if (/^(\*|html|body|:root|:where\(html|::?before|::?after)/i.test(prelude)) globals.push(rule);
      }
    }
  }

  const unique = (rules) => [...new Set(rules)];
  return { fonts: unique(fonts), tokens: unique(tokens), globals: unique(globals) };
}

const attributes = (bag) =>
  Object.entries(bag ?? {})
    .map(([name, value]) => ` ${name}="${String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`)
    .join('');

/**
 * A standalone document that renders one slice on its own.
 *
 * The captured page's own `html` and `body` attributes are reproduced, because
 * that is where the theme class and the font-loader classes live. Without them
 * a component previews in the fallback serif and none of its tokens resolve.
 */
function preview(slice, depth, shell) {
  const up = '../'.repeat(depth);
  return `<!doctype html>
<html${attributes(shell?.html) || ' lang="en"'}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${slice.layer}/${slice.name}</title>
<link rel="stylesheet" href="${up}app/styles/fonts.css">
<link rel="stylesheet" href="${up}app/styles/tokens.css">
<link rel="stylesheet" href="${up}app/styles/global.css">
<link rel="stylesheet" href="./styles.css">
</head>
<body${attributes(shell?.body)}>
<!-- ${slice.layer}/${slice.name} - named by ${slice.namedBy}, ${slice.instances} instance(s) on the page -->
${slice.markup}
</body>
</html>
`;
}

/**
 * Writes every slice found on one route, skipping any already written.
 *
 * `origin` is the page's url, not just its origin: a reference inside a fragment
 * resolves from the document that held it.
 *
 * The same header appears on every route of a site. A slice is identified by
 * its layer, name and structural signature, so it is written once and later
 * routes only record that they use it.
 */
export async function writeSlices(root, { shell, slices }, { ledger, replacements, origin, routeMarker }) {
  const written = [];
  // The detector numbers names within one page, so two routes can each produce
  // a `div-item`. Without a registry across the whole crawl the second would
  // silently overwrite the first.
  const taken = new Set([...ledger.values()].map((record) => record.dir));

  for (const slice of slices) {
    const key = `${slice.layer}/${slice.base ?? slice.name}|${slice.signature}`;
    const already = ledger.get(key);
    if (already) {
      if (!already.routes.includes(routeMarker)) already.routes.push(routeMarker);
      continue;
    }

    // The detector numbers markers so they stay unique within one page; the
    // folder name is numbered here instead, once, against the whole crawl.
    let dir = markerToDir(`${slice.layer}/${slice.base ?? slice.name}`);
    if (taken.has(dir)) {
      let ordinal = 2;
      while (taken.has(`${dir}-${ordinal}`)) ordinal += 1;
      dir = `${dir}-${ordinal}`;
    }
    taken.add(dir);
    const depth = dir.split('/').length + 1;
    const { css, rules, variables } = slice;

    const markup = localise(slice.html, `${dir}/ui/ui.html`, origin, replacements);
    const styles = localise(css, `${dir}/ui/styles.css`, origin, replacements);

    const record = {
      layer: slice.layer,
      name: dir.split('/').pop(),
      dir,
      namedBy: slice.namedBy,
      tag: slice.tag,
      instances: slice.instances,
      nodes: slice.descendants + 1,
      rules,
      variables,
      // Where the author defined it, when the build still says.
      sourceFile: slice.sourceFile ?? null,
      componentStack: slice.componentStack ?? null,
      bytes: { markup: markup.length, styles: styles.length },
      routes: [routeMarker],
    };

    await write(root, `${dir}/ui/ui.html`, `${markup}\n`);
    await write(root, `${dir}/ui/styles.css`, `/* ${slice.layer}/${slice.name} - ${rules} matched rules */\n\n${styles}\n`);
    await write(root, `${dir}/ui/preview.html`, preview({ ...slice, markup }, depth, shell));
    await write(root, `${dir}/meta.json`, `${JSON.stringify(record, null, 2)}\n`);

    ledger.set(key, record);
    written.push(record);
  }

  return written;
}

/** Writes the three app-layer stylesheets. */
export async function writeAppStyles(root, sheetTexts, origin, replacements, shellCss = '') {
  const { fonts, tokens, globals } = splitAppStyles(sheetTexts);
  const emit = (title, rules) =>
    `/* ${title} - ${rules.length} rules, lifted from the site's stylesheets */\n\n${rules.join('\n\n')}\n`;

  // At-rules and custom properties are scanned out of the stylesheet text
  // because they are declarations, not matches. What applies to the document is
  // resolved by the browser instead, the same way a slice's css is.
  const files = {
    'app/styles/fonts.css': emit('@font-face declarations', fonts),
    'app/styles/tokens.css': emit('design tokens on :root', tokens),
    'app/styles/global.css':
      `/* everything that matches html or body, resolved by the css domain */\n\n${shellCss}\n\n` +
      `/* document and reset rules found in the stylesheet text */\n\n${globals.join('\n\n')}\n`,
  };

  for (const [path, contents] of Object.entries(files)) {
    await write(root, path, localise(contents, path, origin, replacements));
  }
  return { fonts: fonts.length, tokens: tokens.length, globals: globals.length, shellBytes: shellCss.length };
}

/** The entry document, which under strict layering is a pointer into `pages`. */
export async function writeEntry(root, homePath) {
  return write(
    root,
    'index.html',
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=./${homePath}">
<title>design-os clone</title>
</head>
<body>
<p>Every route lives under <code>pages/</code>. Continue to <a href="./${homePath}">the entry page</a>.</p>
</body>
</html>
`,
  );
}

const table = (rows) => rows.map((row) => `| ${row.join(' | ')} |`).join('\n');

/** A map of the clone, written where someone opening the folder will find it. */
export async function writeReadme(root, manifest) {
  const layers = ['widgets', 'features', 'entities', 'shared'];
  const counts = layers.map((layer) => [
    `\`${layer}\``,
    manifest.slices.filter((slice) => slice.layer === layer).length,
  ]);

  const listed = manifest.slices
    .slice()
    .sort((a, b) => a.dir.localeCompare(b.dir))
    .map((slice) => [
      `\`${slice.dir}\``,
      slice.tag,
      slice.instances,
      slice.rules,
      slice.namedBy,
      slice.routes.length,
    ]);

  return write(
    root,
    'README.md',
    `# ${manifest.source}

A local copy taken by design-os on ${manifest.capturedAt}, organised as
[Feature-Sliced Design](https://feature-sliced.design). Every route was loaded in
a real browser and the copy was loaded back and scored against it.

## Running it

The clone is a static tree. Serve the folder over http and open the root:

\`\`\`bash
npx serve ${manifest.dir.split('/').pop()}
\`\`\`

\`file://\` works for markup and images, but a browser refuses webfonts over it.

## Layout

\`\`\`
index.html          pointer into pages/, so the folder opens
app/styles/         tokens.css, fonts.css, global.css
pages/<route>/ui/   one slice per cloned route
widgets/<name>/ui/  landmarks: header, footer, nav, aside
features/<name>/ui/ declared interaction: forms, dialogs, menus
entities/<name>/ui/ subtrees the page repeats
shared/ui/<name>/   leaf controls, one folder per distinct control
shared/vendor/      the site's own stylesheets and scripts, verbatim
shared/fonts/       shared/images/  shared/media/
manifest.json       every slice, route and asset, machine readable
\`\`\`

\`app\` and \`shared\` hold segments directly rather than slices, because neither
has business domains. Every other layer holds slices, each with a \`ui\` segment.

## What is in each slice

- \`ui/ui.html\` — the markup, with every reference rewritten to a local file
- \`ui/styles.css\` — **only** the rules that matched that subtree, resolved node
  by node through the CSS domain rather than by searching selectors
- \`ui/preview.html\` — the slice on its own, with the app styles linked
- \`meta.json\` — how it was named, how many instances, how many rules

## Slices

| layer | count |
| --- | --- |
${table(counts)}

| slice | tag | instances | rules | named by | routes |
| --- | --- | --- | --- | --- | --- |
${table(listed)}

## Routes

| route | source |
| --- | --- |
${table(manifest.routes.map((route) => [`\`${route.path}\``, route.url]))}

## Honest limits

- Scripts are saved under \`shared/vendor\` but disabled. The markup is the DOM
  after hydration, so live scripts would hydrate onto markup they did not build.
- Slice names are inferred. \`meta.json\` records the source for each one, and
  \`namedBy: "tag"\` means nothing more specific was available.
- Only what is linked was crawled: ${manifest.routes.length} of
  ${manifest.discovered} destinations found.
`,
  );
}

/** The machine-readable counterpart to the README. */
export async function writeManifest(root, manifest) {
  return write(root, 'manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
}
