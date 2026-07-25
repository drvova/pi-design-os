/**
 * Deterministic design-direction generation.
 *
 * A direction is a complete token set. Given the same seed and count the same
 * directions come back every time, so a run is reproducible and costs nothing
 * to regenerate. Hues are spread evenly around the wheel rather than sampled at
 * random — even spacing is what guarantees N directions look meaningfully
 * different from each other. Every other axis is drawn from a seeded PRNG.
 */

import { css, readableOn, scale, toHex } from './oklch.js';

/** mulberry32 — small, fast, deterministic. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a. Turns a seed phrase into the PRNG's integer seed. */
function hashSeed(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const TONES = [
  { name: 'Muted', intensity: 34 },
  { name: 'Balanced', intensity: 62 },
  { name: 'Vivid', intensity: 92 },
];

const SHAPES = [
  { name: 'Sharp', radius: [0, 0, 0], pill: '0' },
  { name: 'Soft', radius: [0.125, 0.25, 0.375], pill: '9999px' },
  { name: 'Round', radius: [0.375, 0.625, 0.875], pill: '9999px' },
  { name: 'Pill', radius: [0.5, 1, 1.75], pill: '9999px' },
];

const DENSITIES = [
  { name: 'Tight', unit: 0.2, lead: 1.35 },
  { name: 'Even', unit: 0.28, lead: 1.5 },
  { name: 'Airy', unit: 0.4, lead: 1.7 },
];

const TYPEFACES = [
  {
    name: 'System',
    sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
    ratio: 1.2,
    weight: [400, 600],
  },
  {
    name: 'Grotesk',
    sans: '"Helvetica Neue", Helvetica, Arial, ui-sans-serif, sans-serif',
    mono: 'ui-monospace, Menlo, Consolas, monospace',
    ratio: 1.25,
    weight: [400, 700],
  },
  {
    name: 'Serif',
    sans: 'ui-serif, Georgia, Cambria, "Times New Roman", serif',
    mono: 'ui-monospace, "Courier New", monospace',
    ratio: 1.333,
    weight: [400, 700],
  },
  {
    name: 'Mono',
    sans: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    ratio: 1.15,
    weight: [400, 500],
  },
];

const MOTIONS = [
  { name: 'Still', duration: '0ms', ease: 'linear', lift: '0' },
  { name: 'Calm', duration: '180ms', ease: 'cubic-bezier(0.4, 0, 0.2, 1)', lift: '-1px' },
  { name: 'Springy', duration: '320ms', ease: 'cubic-bezier(0.34, 1.56, 0.64, 1)', lift: '-3px' },
];

const POLARITIES = [
  { name: 'Light', surfaceL: 0.97, canvasL: 0.99 },
  { name: 'Dark', surfaceL: 0.21, canvasL: 0.15 },
];

/** Hue names by wheel position, used to label directions. */
const HUE_NAMES = [
  [15, 'Crimson'], [45, 'Amber'], [70, 'Gold'], [100, 'Lime'], [150, 'Green'],
  [180, 'Emerald'], [210, 'Cyan'], [250, 'Azure'], [280, 'Indigo'],
  [310, 'Violet'], [345, 'Magenta'], [360, 'Crimson'],
];

function hueName(hue) {
  return HUE_NAMES.find(([bound]) => hue < bound)[1];
}

function pick(list, random) {
  return list[Math.floor(random() * list.length)];
}

/** Builds the CSS custom properties for one direction. */
function tokensFor({ hue, tone, shape, density, typeface, motion, polarity }) {
  const ramp = scale(polarity.name === 'Dark' ? 0.62 : 0.55, tone.intensity, hue);
  const byStep = Object.fromEntries(ramp.map((s) => [s.step, s]));
  const accent = polarity.name === 'Dark' ? byStep[300] : byStep[700];
  const textL = readableOn(polarity.surfaceL);
  const neutralChroma = 0.008;
  const [regular, bold] = typeface.weight;
  const [sm, md, lg] = shape.radius;
  const step = (n) => `${(density.unit * n).toFixed(3)}rem`;

  return {
    '--ds-canvas': css(polarity.canvasL, neutralChroma, hue),
    '--ds-surface': css(polarity.surfaceL, neutralChroma, hue),
    '--ds-text': css(textL, neutralChroma, hue),
    '--ds-muted': css(polarity.name === 'Dark' ? 0.68 : 0.48, neutralChroma * 2, hue),
    '--ds-border': css(polarity.name === 'Dark' ? 0.34 : 0.88, neutralChroma * 2, hue),
    '--ds-accent': accent.css,
    '--ds-accent-hover': (polarity.name === 'Dark' ? byStep[200] : byStep[800]).css,
    '--ds-accent-text': css(readableOn(accent.l), neutralChroma, hue),
    '--ds-accent-subtle': (polarity.name === 'Dark' ? byStep[900] : byStep[100]).css,

    '--ds-radius-sm': `${sm}rem`,
    '--ds-radius-md': `${md}rem`,
    '--ds-radius-lg': `${lg}rem`,
    '--ds-radius-pill': shape.pill,

    '--ds-space-1': step(1),
    '--ds-space-2': step(2),
    '--ds-space-3': step(3),
    '--ds-space-4': step(5),
    '--ds-space-5': step(8),

    '--ds-font-sans': typeface.sans,
    '--ds-font-mono': typeface.mono,
    '--ds-weight-regular': String(regular),
    '--ds-weight-bold': String(bold),
    '--ds-leading': String(density.lead),
    '--ds-text-sm': `${(1 / typeface.ratio).toFixed(3)}rem`,
    '--ds-text-base': '1rem',
    '--ds-text-lg': `${typeface.ratio.toFixed(3)}rem`,
    '--ds-text-xl': `${(typeface.ratio ** 2).toFixed(3)}rem`,
    '--ds-text-2xl': `${(typeface.ratio ** 3).toFixed(3)}rem`,

    '--ds-duration': motion.duration,
    '--ds-ease': motion.ease,
    '--ds-lift': motion.lift,
    '--ds-shadow':
      motion.name === 'Still'
        ? 'none'
        : `0 1px 2px ${toHex(polarity.name === 'Dark' ? 0.05 : 0.7, 0.02, hue)}40`,
  };
}

/**
 * Generates `count` directions.
 *
 * @param {object} options
 * @param {number} options.count  how many directions, 1-64
 * @param {string} options.seed  any phrase; identical seeds reproduce identical output
 * @param {'light'|'dark'|'both'} [options.polarity='both']
 * @returns {Array<{id:string,label:string,body:string,axes:object,tokens:object}>}
 */
export function generate({ count, seed, polarity = 'both' }) {
  if (!Number.isInteger(count) || count < 1 || count > 64) {
    throw new RangeError('count must be an integer between 1 and 64');
  }

  const random = prng(hashSeed(seed));
  const rotation = random() * 360;
  const poles =
    polarity === 'both' ? POLARITIES : POLARITIES.filter((p) => p.name.toLowerCase() === polarity);
  if (poles.length === 0) throw new RangeError(`unknown polarity: ${polarity}`);

  return Array.from({ length: count }, (_, i) => {
    const hue = (rotation + (360 * i) / count) % 360;
    const axes = {
      hue,
      tone: pick(TONES, random),
      shape: pick(SHAPES, random),
      density: pick(DENSITIES, random),
      typeface: pick(TYPEFACES, random),
      motion: pick(MOTIONS, random),
      polarity: poles[i % poles.length],
    };

    return {
      id: `d${String(i + 1).padStart(2, '0')}`,
      label: `${axes.tone.name} ${hueName(hue)}`,
      body: `${axes.shape.name} · ${axes.density.name} · ${axes.typeface.name} · ${axes.motion.name}`,
      axes: {
        hue: Number(hue.toFixed(1)),
        tone: axes.tone.name,
        shape: axes.shape.name,
        density: axes.density.name,
        typeface: axes.typeface.name,
        motion: axes.motion.name,
        polarity: axes.polarity.name,
      },
      tokens: tokensFor(axes),
    };
  });
}
