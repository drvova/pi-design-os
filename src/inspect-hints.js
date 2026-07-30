/**
 * Link relations that only describe loading.
 *
 * Shared, because the analyser names them when it reports the pre-DOM phase and
 * the cloner strips them, and a link that one of them knows about and the other
 * does not is exactly how a stylesheet goes missing.
 */
export const HINT_RELS = new Set([
  'preconnect',
  'dns-prefetch',
  'preload',
  'modulepreload',
  'prefetch',
  'prerender',
]);
