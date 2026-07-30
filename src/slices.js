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

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { localise } from './clone.js';
import { SLICES } from './probe.js';

/** Rules the browser supplies itself are not part of the design. */
const AUTHORED = new Set(['regular', 'author', 'inspector', 'injected']);

const MARKER = 'data-design-os-slice';

/**
 * Selectors that address the document rather than a component.
 *
 * A universal selector matches every node, so the CSS domain returns Tailwind's
 * preflight for every slice on the page. Those rules are the app layer's, and
 * repeating them under all 71 components would bury each one's own handful of
 * rules and leave the reset with no single home. Previews link the app styles,
 * so nothing is lost by removing them here.
 */
const DOCUMENT_SCOPED = /^(\*|html|body|:root|::?before|::?after|:where\(html\)|:where\(body\))$/;

const isDocumentScoped = (selector) =>
  selector.split(',').every((part) => DOCUMENT_SCOPED.test(part.trim()));

/** `shared` holds segments directly, so its slices live under the `ui` segment. */
export const markerToDir = (marker) => (marker.startsWith('shared/') ? `shared/ui/${marker.slice(7)}` : marker);

async function write(root, relative, contents) {
  const target = join(root, ...relative.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, 'utf8');
  return relative;
}

/**
 * Detects slices and resolves the css for each, against the live document.
 *
 * This has to run before the page is serialized: detection marks the nodes, and
 * the CSS domain can only answer about a document that still exists. Writing
 * happens later, once the asset map is known and references can be rewritten.
 */
export async function collectSlices(session) {
  const result = await session.send('Runtime.evaluate', { expression: SLICES, returnByValue: true });
  if (result.exceptionDetails) throw new Error(`slice detection failed: ${result.exceptionDetails.text}`);

  // The detector already applies its own thresholds, and a leaf control has no
  // element children by definition: a node count gate here would drop every
  // shared primitive, which is the layer that exists to hold them.
  const { shell = { html: {}, body: {} }, slices = [] } = result.result.value ?? {};
  const detected = slices.filter((slice) => slice.html);
  if (detected.length === 0) return { shell, slices: [] };

  const documentNode = await session.send('DOM.getDocument', { depth: 1 });
  const collected = [];

  for (const slice of detected) {
    const matched = await matchedCss(session, documentNode.root.nodeId, `[${MARKER}="${slice.marker}"]`);
    collected.push({ ...slice, ...matched });
  }

  // What styles the document itself. A class-based body rule such as
  // `.font-sans` is neither a slice's rule nor a selector starting with `body`,
  // so neither the per-slice pass nor a text scan would ever find it, and every
  // preview would render in the fallback serif.
  const shellCss = await matchedCss(session, documentNode.root.nodeId, 'html, body', { keepDocumentScoped: true });

  return { shell: { ...shell, css: shellCss.css, rules: shellCss.rules }, slices: collected };
}

/**
 * The css that actually applies to one marked subtree.
 *
 * Every node under the root is asked separately, because a rule matching a
 * descendant is part of the component even when nothing selects the root.
 */
async function matchedCss(session, documentId, marker, { keepDocumentScoped = false } = {}) {
  const roots = await session.send('DOM.querySelectorAll', { nodeId: documentId, selector: marker });
  if (roots.nodeIds.length === 0) return { css: '', rules: 0, variables: [] };

  // The shell is two nodes; a slice is a root and everything beneath it.
  const targets = keepDocumentScoped
    ? roots.nodeIds
    : [roots.nodeIds[0], ...(await session.send('DOM.querySelectorAll', { nodeId: roots.nodeIds[0], selector: '*' })).nodeIds];

  const seen = new Set();
  const blocks = [];

  for (const nodeId of targets) {
    const matched = await session
      .send('CSS.getMatchedStylesForNode', { nodeId })
      .catch(() => null);
    if (!matched) continue;

    for (const entry of matched.matchedCSSRules ?? []) {
      const rule = entry.rule;
      if (!AUTHORED.has(rule.origin)) continue;

      const selector = rule.selectorList?.text ?? '';
      const body = rule.style?.cssText?.trim();
      if (!selector || !body) continue;
      if (!keepDocumentScoped && isDocumentScoped(selector)) continue;

      const conditions = (rule.media ?? []).map((query) => query.text).filter(Boolean);
      const key = `${conditions.join('&')}|${selector}|${body}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const declaration = `${selector} {\n  ${body.replace(/;\s*/g, ';\n  ').trim()}\n}`;
      blocks.push(
        conditions.reduceRight((inner, condition) => `@media ${condition} {\n${inner.replace(/^/gm, '  ')}\n}`, declaration),
      );
    }
  }

  const css = blocks.join('\n\n');
  return {
    css,
    rules: blocks.length,
    variables: [...new Set([...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]))].sort(),
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
