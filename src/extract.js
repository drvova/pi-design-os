/**
 * Rendered page to design direction.
 *
 * The harvest returns what a site actually paints: colours weighted by the area
 * they cover, type by where text sits, radius and motion by how often each value
 * recurs. This module snaps those observations onto the same axes generated
 * directions use and hands them to the same `tokensFor`, so an inspected site
 * comes back as a direction — comparable against generated ones and renderable
 * by the existing gallery with no second code path.
 *
 * Observed values are carried through untouched alongside the snapped axes.
 * Snapping makes a site comparable; the raw reading is what makes it truthful.
 */

import {
  DENSITIES,
  MOTIONS,
  POLARITIES,
  SHAPES,
  TONES,
  hueName,
  tokensFor,
} from './directions.js';
import { fromRgb, maxChroma, toHex } from './oklch.js';

/** Below this chroma a colour reads as grey and carries no usable hue. */
const NEUTRAL_CHROMA = 0.025;

const number = (text) => {
  const match = /-?[\d.]+/.exec(String(text ?? ''));
  return match ? Number(match[0]) : Number.NaN;
};

/** `"34,197,94"` as written by the harvest. */
function readRgb(value) {
  const [r, g, b] = String(value).split(',').map(Number);
  return Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) ? { r, g, b } : null;
}

function measured(entry) {
  const rgb = entry && readRgb(entry.value);
  if (!rgb) return null;
  const { l, c, h } = fromRgb(rgb.r, rgb.g, rgb.b);
  return { rgb, l, c, h, hex: toHex(l, c, h), weight: entry.weight };
}

/** Nearest entry in an axis table by a numeric projection. */
function snap(table, project, target) {
  return table.reduce((best, candidate) =>
    Math.abs(project(candidate) - target) < Math.abs(project(best) - target) ? candidate : best,
  );
}

/** Seconds or milliseconds as written by `transition-duration`, in ms. */
function durationMs(text) {
  const value = number(text);
  if (!Number.isFinite(value)) return Number.NaN;
  return /ms\b/.test(String(text)) ? value : value * 1000;
}

/**
 * Median ratio between consecutive distinct font sizes.
 *
 * A single pair is noise; the median across the whole scale is the ratio the
 * site was actually typeset on.
 */
function typeRatio(sizes) {
  const steps = [...new Set(sizes.map((entry) => number(entry.value)).filter(Number.isFinite))]
    .sort((a, b) => a - b)
    .filter((size) => size >= 8 && size <= 200);

  const ratios = steps.slice(1).map((size, index) => size / steps[index]).filter((r) => r > 1.02 && r < 2.2);
  if (ratios.length === 0) return 1.2;

  ratios.sort((a, b) => a - b);
  return Math.round(ratios[Math.floor(ratios.length / 2)] * 1000) / 1000;
}

/** Observed family in front of a fallback stack, quoted and deduplicated. */
function fontStack(family, fallbacks) {
  const head = /^[a-zA-Z][\w-]*$/.test(family) ? family : `"${family.replace(/"/g, '')}"`;
  return [head, ...fallbacks.filter((entry) => entry !== family)].join(', ');
}

/**
 * The colour a site is built on: the most chromatic thing it puts weight behind.
 *
 * Accent candidates come first because links and buttons carry brand colour far
 * more reliably than page backgrounds, which are usually near-neutral.
 */
function findAccent(design) {
  const candidates = [...design.accents, ...design.foreground, ...design.background]
    .map(measured)
    .filter((entry) => entry && entry.c >= NEUTRAL_CHROMA && entry.l > 0.12 && entry.l < 0.95);

  if (candidates.length === 0) return null;
  return candidates.reduce((best, entry) => (entry.c * entry.weight > best.c * best.weight ? entry : best));
}

/**
 * Turns one harvested design into a direction.
 *
 * @param {object} design harvest `design` block
 * @param {{url:string, title?:string}} meta
 * @returns {{id:string,label:string,body:string,axes:object,tokens:object,observed:object}}
 */
export function toDirection(design, meta) {
  const surface = measured(design.background[0]) ?? { l: 1, c: 0, h: 0, hex: '#ffffff', weight: 0 };
  const accent = findAccent(design);
  const hue = accent ? accent.h : surface.h;

  const polarity = surface.l >= 0.5 ? POLARITIES[0] : POLARITIES[1];

  const headroom = accent ? maxChroma(accent.l, accent.h) : 0;
  const intensity = headroom > 0 ? Math.min(100, (accent.c / headroom) * 100) : 0;
  const tone = snap(TONES, (entry) => entry.intensity, intensity);

  const radiusRem = number(design.radii[0]?.value) / 16;
  const shape = Number.isFinite(radiusRem)
    ? snap(SHAPES, (entry) => entry.radius[1], radiusRem)
    : SHAPES[1];

  // Padding lands on step 2 of the scale far more often than any other step.
  const spacingRem = number(design.spacing[0]?.value) / 16;
  const density = Number.isFinite(spacingRem)
    ? snap(DENSITIES, (entry) => entry.unit * 2, spacingRem)
    : DENSITIES[1];

  const duration = durationMs(design.durations[0]?.value);
  const motion = Number.isFinite(duration)
    ? snap(MOTIONS, (entry) => durationMs(entry.duration), duration)
    : MOTIONS[1];

  const family = design.families[0]?.value ?? 'system-ui';
  const observedWeights = design.weights
    .map((entry) => number(entry.value))
    .filter((weight) => Number.isFinite(weight) && weight >= 100 && weight <= 900)
    .sort((a, b) => a - b);

  const typeface = {
    name: family,
    sans: fontStack(family, ['ui-sans-serif', 'system-ui', 'sans-serif']),
    mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    ratio: typeRatio(design.sizes),
    weight: [observedWeights[0] ?? 400, observedWeights.at(-1) ?? 600],
  };

  const axes = { hue, tone, shape, density, typeface, motion, polarity };
  const host = new URL(meta.url).hostname.replace(/^www\./, '');

  return {
    id: `site-${host.replace(/[^a-z0-9]+/gi, '-')}`,
    label: `${tone.name} ${hueName(hue)}`,
    body: `${shape.name} · ${density.name} · ${typeface.name} · ${motion.name}`,
    axes: {
      hue: Math.round(hue),
      tone: tone.name,
      shape: shape.name,
      density: density.name,
      typeface: typeface.name,
      motion: motion.name,
      polarity: polarity.name,
    },
    tokens: tokensFor(axes),
    observed: {
      source: meta.url,
      title: meta.title ?? host,
      surface: { hex: surface.hex, l: Number(surface.l.toFixed(3)) },
      accent: accent
        ? { hex: accent.hex, l: Number(accent.l.toFixed(3)), c: Number(accent.c.toFixed(3)), h: Math.round(accent.h) }
        : null,
      chromaHeadroom: Number(headroom.toFixed(3)),
      palette: [...design.background, ...design.accents]
        .map(measured)
        .filter(Boolean)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 12)
        .map((entry) => ({
          hex: entry.hex,
          oklch: `oklch(${entry.l.toFixed(3)} ${entry.c.toFixed(3)} ${entry.h.toFixed(1)})`,
          weight: entry.weight,
          neutral: entry.c < NEUTRAL_CHROMA,
        })),
      typeScale: { ratio: typeface.ratio, sizes: design.sizes.map((entry) => entry.value) },
      families: design.families.map((entry) => entry.value),
      weights: observedWeights,
      leading: design.leading.map((entry) => entry.value),
      tracking: design.tracking.map((entry) => entry.value),
      radii: design.radii.map((entry) => entry.value),
      shadows: design.shadows.map((entry) => entry.value),
      borders: design.borders.map((entry) => entry.value),
      spacing: design.spacing.map((entry) => entry.value),
      motion: {
        durations: design.durations.map((entry) => entry.value),
        easings: design.easings.map((entry) => entry.value),
      },
      // A site that publishes custom properties has stated its design system outright.
      declaredTokens: design.customProperties,
    },
  };
}
