/**
 * OKLCH colour maths — conversion, gamut boundary, and palette scales.
 *
 * OKLCH is used rather than HSL because equal lightness steps are perceptually
 * equal, hue stays stable across the lightness range, and chroma is independent
 * of lightness. That is what makes generated directions comparable: two
 * directions at the same L carry the same visual weight regardless of hue.
 *
 * Conversion matrices are Björn Ottosson's published OKLab constants.
 */

const DEG_TO_RAD = Math.PI / 180;

/** Lightness bounds. Pure black and white hold no chroma, so the scale stops short. */
export const L_MIN = 0.05;
export const L_MAX = 0.95;

/** Standard 9-step design-system scale, lightest to darkest. */
export const SCALE_STEPS = [50, 100, 200, 300, 500, 700, 800, 900, 950];

function linearToGamma(x) {
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

function gammaToLinear(x) {
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

/**
 * 8-bit sRGB to OKLCH. The inverse of `oklchToLinearSrgb`, on the same Ottosson
 * constants, so a colour read off a rendered page lands in the coordinate space
 * generated directions already use and can be compared against them directly.
 *
 * @param {number} r 0-255
 * @param {number} g 0-255
 * @param {number} b 0-255
 * @returns {{l:number,c:number,h:number}} hue in degrees, 0-360
 */
export function fromRgb(r, g, b) {
  const lr = gammaToLinear(r / 255);
  const lg = gammaToLinear(g / 255);
  const lb = gammaToLinear(b / 255);

  const lRoot = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const mRoot = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const sRoot = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);

  const l = 0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot;
  const a = 1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot;
  const b2 = 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot;

  const hue = (Math.atan2(b2, a) / DEG_TO_RAD + 360) % 360;
  return { l, c: Math.hypot(a, b2), h: hue };
}

/** OKLCH to linear-light sRGB. Channels may fall outside [0,1] when out of gamut. */
function oklchToLinearSrgb(l, c, h) {
  const a = c * Math.cos(h * DEG_TO_RAD);
  const b = c * Math.sin(h * DEG_TO_RAD);

  const lCube = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mCube = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sCube = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    4.0767416621 * lCube - 3.3077115913 * mCube + 0.2309699292 * sCube,
    -1.2684380046 * lCube + 2.6097574011 * mCube - 0.3413193965 * sCube,
    -0.0041960863 * lCube - 0.7034186147 * mCube + 1.707614701 * sCube,
  ];
}

/** True when the colour renders without clipping in sRGB. */
export function inSrgbGamut(l, c, h) {
  const eps = 1e-6;
  return oklchToLinearSrgb(l, c, h).every((v) => v >= -eps && v <= 1 + eps);
}

/** Highest in-gamut chroma for a lightness and hue. Bisection to 1e-4. */
export function maxChroma(l, h) {
  let lo = 0;
  let hi = 0.4;
  if (inSrgbGamut(l, hi, h)) return hi;
  while (hi - lo > 1e-4) {
    const mid = (lo + hi) / 2;
    if (inSrgbGamut(l, mid, h)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Clamps chroma into gamut, holding lightness and hue fixed. */
export function clampChroma(l, c, h) {
  const limit = maxChroma(l, h);
  return c <= limit ? c : limit;
}

/** Hex string for an OKLCH colour, clamped into sRGB. Used for fallbacks and swatches. */
export function toHex(l, c, h) {
  const channels = oklchToLinearSrgb(l, clampChroma(l, c, h), h)
    .map((v) => Math.round(Math.min(1, Math.max(0, linearToGamma(v))) * 255))
    .map((v) => v.toString(16).padStart(2, '0'));
  return `#${channels.join('')}`;
}

/** CSS `oklch()` string, rounded for readability. */
export function css(l, c, h) {
  return `oklch(${l.toFixed(3)} ${clampChroma(l, c, h).toFixed(3)} ${h.toFixed(1)})`;
}

/**
 * Builds a 9-step scale around a base colour.
 *
 * Lightness spreads +/- 0.4 from the base, clamped to [0.05, 0.95], and is
 * distributed evenly from lightest (step 50) to darkest (step 950). Chroma at
 * each step is `intensity` percent of that step's gamut maximum, so the ends of
 * the scale desaturate on their own rather than clipping.
 *
 * @param {number} baseL  base lightness, 0-1
 * @param {number} intensity  percentage of maximum chroma, 0-100
 * @param {number} hue  0-360
 * @returns {Array<{step:number,l:number,c:number,h:number,css:string,hex:string}>}
 */
export function scale(baseL, intensity, hue) {
  const delta = 0.4;
  const maxL = Math.min(L_MAX, baseL + delta);
  const minL = Math.max(L_MIN, baseL - delta);
  const span = maxL - minL;
  const last = SCALE_STEPS.length - 1;

  return SCALE_STEPS.map((step, i) => {
    const l = maxL - (span * i) / last;
    const c = (intensity / 100) * maxChroma(l, hue);
    return { step, l, c, h: hue, css: css(l, c, hue), hex: toHex(l, c, hue) };
  });
}

/**
 * Readable foreground lightness for a background lightness.
 *
 * Light backgrounds (L > 0.85) need foregrounds below 0.45; dark backgrounds
 * (L < 0.25) need foregrounds above 0.75. Between those, pick whichever pole is
 * further away to keep the gap wide.
 */
export function readableOn(backgroundL) {
  if (backgroundL > 0.85) return 0.25;
  if (backgroundL < 0.25) return 0.95;
  return backgroundL > 0.5 ? 0.2 : 0.97;
}
