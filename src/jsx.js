/**
 * HTML to JSX attribute rewriting.
 *
 * Authored markup is already valid JSX apart from a handful of reserved
 * attribute names, so a rewrite is all that is needed — no parser, no compiler.
 * Svelte and Vue templates are HTML supersets and take the markup verbatim,
 * which is why JSX is the only transform that exists here.
 *
 * The input must be the authored source, never `innerHTML` read back from the
 * DOM: the parser unclosed void elements and expands `checked` to `checked=""`,
 * and neither form parses as JSX.
 *
 * This function's source is also inlined into the gallery page, so it must stay
 * dependency-free and self-contained.
 */
export function toJsx(html) {
  return html
    .replace(/\bclass=/g, 'className=')
    .replace(/\bfor=/g, 'htmlFor=')
    .replace(/\bchecked\b(?!=)/g, 'defaultChecked');
}
