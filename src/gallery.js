/**
 * Renders every direction into one self-contained HTML document.
 *
 * No build step and no runtime dependency: directions are isolated by scoping
 * their custom properties to a wrapper element. Custom properties inherit, so
 * one stylesheet drives every preview and nothing leaks between them. The
 * document's own chrome sits outside those wrappers and keeps its own colours.
 */

import { COMPONENTS, COMPONENT_CSS } from './components.js';
import { toJsx } from './jsx.js';

/** Escapes text for use in an HTML text node or quoted attribute. */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Escapes JSON for embedding inside a <script> element. */
function escapeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function tokenStyle(tokens) {
  return Object.entries(tokens)
    .map(([key, value]) => `${key}:${value}`)
    .join(';');
}

const SHELL_CSS = `
:root { color-scheme: light dark; --chrome-gap: 1.5rem; }
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: var(--chrome-gap);
  background: #0d0d0f;
  color: #e8e8ea;
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.shell-head {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: var(--chrome-gap);
}
.shell-head h1 { margin: 0; font-size: 1rem; font-weight: 600; letter-spacing: -0.01em; }
.shell-meta { color: #8b8b93; font-size: 12px; }
.shell-controls { display: flex; gap: 0.5rem; align-items: center; }
.shell-controls select, .shell-controls input {
  font: inherit;
  padding: 0.35rem 0.5rem;
  border: 1px solid #2c2c31;
  border-radius: 6px;
  background: #17171a;
  color: inherit;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: var(--chrome-gap);
}
.direction {
  display: flex;
  flex-direction: column;
  border: 1px solid #2c2c31;
  border-radius: 10px;
  overflow: hidden;
  background: #131316;
}
.direction[hidden] { display: none; }
.direction__head {
  display: flex;
  gap: 0.75rem;
  align-items: baseline;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid #2c2c31;
}
.direction__name { font-weight: 600; }
.direction__id { color: #6c6c75; font-size: 12px; font-variant-numeric: tabular-nums; }
.direction__axes { padding: 0 1rem 0.75rem; color: #8b8b93; font-size: 12px; }
.direction__swatch { display: flex; gap: 3px; padding: 0 1rem 0.75rem; }
.direction__swatch i { width: 100%; height: 6px; border-radius: 2px; }
.preview { display: grid; gap: 1rem; align-content: start; flex: 1; padding: 1.25rem; }
.piece { position: relative; }
.piece__copy {
  position: absolute;
  inset-block-start: -0.4rem;
  inset-inline-end: -0.4rem;
  z-index: 1;
  padding: 0.2rem 0.45rem;
  font: 600 11px/1 ui-sans-serif, system-ui, sans-serif;
  color: #e8e8ea;
  background: #26262c;
  border: 1px solid #3a3a42;
  border-radius: 5px;
  opacity: 0;
  cursor: pointer;
  transition: opacity 120ms ease;
}
.piece:hover .piece__copy, .piece__copy:focus-visible { opacity: 1; }
.piece__copy[data-state="done"] { background: #1d4d2b; border-color: #2c7a41; }
.empty { padding: 2rem; color: #8b8b93; text-align: center; }
`.trim();

/** Clipboard and filtering. Runs in the page; kept dependency-free. */
const SHELL_JS = String.raw`
const DATA = JSON.parse(document.getElementById('directions-data').textContent);
const BASE_CSS = document.getElementById('component-css').textContent.trim();
const byId = new Map(DATA.map((d) => [d.id, d]));

// Copy reads the authored markup, never the rendered DOM. innerHTML normalises
// void elements to their unclosed form and expands boolean attributes, which
// would emit JSX that does not parse.
const SOURCE = new Map(
  JSON.parse(document.getElementById('components-data').textContent).map((c) => [c.name, c.html]),
);

// Inlined from src/jsx.js so the page and the Node tests share one definition.
${toJsx}

function tokenBlock(direction, selector) {
  const body = Object.entries(direction.tokens)
    .map(([key, value]) => '  ' + key + ': ' + value + ';')
    .join('\n');
  return selector + ' {\n' + body + '\n}';
}

function payload(direction, markup, format) {
  const tokens = tokenBlock(direction, '.ds-root');
  if (format === 'jsx') {
    return '// ' + direction.label + ' — ' + direction.body + '\n' +
      'export function Component() {\n  return (\n' +
      toJsx(markup).split('\n').map((l) => '    ' + l).join('\n') +
      '\n  );\n}\n\n/* ' + tokens + '\n\n' + BASE_CSS + ' */';
  }
  return '<!-- ' + direction.label + ' — ' + direction.body + ' -->\n' + markup +
    '\n\n<style>\n' + tokens + '\n\n' + BASE_CSS + '\n</style>';
}

document.addEventListener('click', async (event) => {
  const trigger = event.target.closest('.piece__copy');
  if (!trigger) return;
  const piece = trigger.closest('.piece');
  const direction = byId.get(piece.closest('.direction').dataset.id);
  const markup = SOURCE.get(piece.querySelector('[data-markup]').dataset.component);
  const format = document.getElementById('format').value;

  await navigator.clipboard.writeText(payload(direction, markup, format));
  trigger.textContent = 'copied';
  trigger.dataset.state = 'done';
  setTimeout(() => {
    trigger.textContent = 'copy';
    delete trigger.dataset.state;
  }, 1200);
});

document.getElementById('filter').addEventListener('input', (event) => {
  const term = event.target.value.trim().toLowerCase();
  let shown = 0;
  for (const node of document.querySelectorAll('.direction')) {
    const match = !term || node.dataset.search.includes(term);
    node.hidden = !match;
    if (match) shown += 1;
  }
  document.getElementById('shown').textContent = shown;
});
`.trim();

function renderPiece(component) {
  return `<div class="piece">
            <button class="piece__copy" type="button">copy</button>
            <div data-markup data-component="${escapeHtml(component.name)}">${component.html}</div>
          </div>`;
}

function renderDirection(direction) {
  const search = [direction.label, direction.body, ...Object.values(direction.axes)]
    .join(' ')
    .toLowerCase();
  const swatch = ['--ds-canvas', '--ds-surface', '--ds-border', '--ds-muted', '--ds-accent']
    .map((key) => `<i style="background:${escapeHtml(direction.tokens[key])}"></i>`)
    .join('');

  return `<article class="direction" data-id="${escapeHtml(direction.id)}" data-search="${escapeHtml(search)}">
        <header class="direction__head">
          <span class="direction__name">${escapeHtml(direction.label)}</span>
          <span class="direction__id">${escapeHtml(direction.id)}</span>
        </header>
        <p class="direction__axes">${escapeHtml(direction.body)}</p>
        <div class="direction__swatch">${swatch}</div>
        <div class="ds-root preview" style="${escapeHtml(tokenStyle(direction.tokens))}">
          ${COMPONENTS.map(renderPiece).join('\n          ')}
        </div>
      </article>`;
}

/**
 * @param {Array} directions  output of `generate()`
 * @param {object} [meta]  seed and title shown in the header
 * @returns {string} a complete standalone HTML document
 */
export function render(directions, meta = {}) {
  const title = meta.title ?? 'design-os directions';
  const seed = meta.seed ?? '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${SHELL_CSS}</style>
<style id="component-css">${COMPONENT_CSS}</style>
</head>
<body>
<header class="shell-head">
  <div>
    <h1>${escapeHtml(title)}</h1>
    <div class="shell-meta">
      <span id="shown">${directions.length}</span> of ${directions.length} directions${
        seed ? ` · seed <code>${escapeHtml(seed)}</code>` : ''
      }
    </div>
  </div>
  <div class="shell-controls">
    <input id="filter" type="search" placeholder="Filter directions" aria-label="Filter directions" />
    <select id="format" aria-label="Copy format">
      <option value="html">Copy as HTML</option>
      <option value="jsx">Copy as JSX</option>
    </select>
  </div>
</header>
<main class="grid">
      ${directions.map(renderDirection).join('\n      ')}
</main>
<script type="application/json" id="directions-data">${escapeJson(directions)}</script>
<script type="application/json" id="components-data">${escapeJson(COMPONENTS)}</script>
<script>${SHELL_JS}</script>
</body>
</html>
`;
}
