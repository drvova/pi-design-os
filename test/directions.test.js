import assert from 'node:assert/strict';
import test from 'node:test';

import { COMPONENTS, COMPONENT_CSS } from '../src/components.js';
import { generate } from '../src/directions.js';
import { render } from '../src/gallery.js';
import { toJsx } from '../src/jsx.js';
import { inSrgbGamut, maxChroma, readableOn, scale } from '../src/oklch.js';

test('every scale step stays inside the sRGB gamut', () => {
  for (const hue of [0, 30, 90, 150, 195, 250, 285, 330]) {
    for (const intensity of [34, 62, 92, 100]) {
      for (const step of scale(0.55, intensity, hue)) {
        assert.ok(
          inSrgbGamut(step.l, step.c, step.h),
          `clipped at hue ${hue} intensity ${intensity} step ${step.step}`,
        );
      }
    }
  }
});

test('maxChroma reflects the known sRGB boundary at L=0.5', () => {
  // Cyan is the least saturated hue in sRGB; purple the most.
  assert.ok(maxChroma(0.5, 195) < maxChroma(0.5, 285));
  assert.ok(maxChroma(0.5, 195) < 0.13);
  assert.ok(maxChroma(0.5, 285) > 0.25);
});

test('scale runs lightest to darkest with no repeated lightness', () => {
  const steps = scale(0.55, 62, 250);
  assert.equal(steps.length, 9);
  for (let i = 1; i < steps.length; i += 1) {
    assert.ok(steps[i].l < steps[i - 1].l, `step ${steps[i].step} is not darker than its predecessor`);
  }
});

test('readableOn opens a wide lightness gap on both poles', () => {
  assert.ok(readableOn(0.97) < 0.45);
  assert.ok(readableOn(0.15) > 0.75);
});

test('the same seed reproduces the same directions', () => {
  assert.deepEqual(generate({ count: 8, seed: 'kaizen' }), generate({ count: 8, seed: 'kaizen' }));
});

test('different seeds produce different directions', () => {
  const a = generate({ count: 8, seed: 'kaizen' });
  const b = generate({ count: 8, seed: 'jidoka' });
  assert.notDeepEqual(a, b);
});

test('hues spread evenly so directions stay visually distinct', () => {
  const hues = generate({ count: 12, seed: 'spread' }).map((d) => d.axes.hue);
  assert.equal(new Set(hues).size, 12);
  const gaps = hues.map((hue, i) => (hue - hues[i - 1] + 360) % 360).slice(1);
  for (const gap of gaps) assert.ok(Math.abs(gap - 30) < 0.5, `uneven hue gap: ${gap}`);
});

test('polarity filter is honoured', () => {
  const dark = generate({ count: 6, seed: 'dark-only', polarity: 'dark' });
  assert.ok(dark.every((d) => d.axes.polarity === 'Dark'));
});

test('count outside 1-64 is rejected', () => {
  assert.throws(() => generate({ count: 0, seed: 'x' }), RangeError);
  assert.throws(() => generate({ count: 65, seed: 'x' }), RangeError);
  assert.throws(() => generate({ count: 2.5, seed: 'x' }), RangeError);
});

test('every token the stylesheet reads is defined by every direction', () => {
  const referenced = new Set(
    [...COMPONENT_CSS.matchAll(/var\((--ds-[a-z0-9-]+)\)/g)].map((match) => match[1]),
  );
  assert.ok(referenced.size > 15, `only found ${referenced.size} token references`);

  for (const direction of generate({ count: 8, seed: 'tokens', polarity: 'both' })) {
    for (const token of referenced) {
      assert.ok(direction.tokens[token], `${direction.id} is missing ${token}`);
    }
  }
});

test('gallery renders one scoped block per direction and embeds its data', () => {
  const directions = generate({ count: 4, seed: 'gallery' });
  const html = render(directions, { seed: 'gallery' });

  assert.match(html, /^<!doctype html>/);
  assert.equal(html.match(/class="direction"/g).length, 4);
  assert.equal(html.match(/class="ds-root preview"/g).length, 4);
  assert.equal(html.match(/class="piece__copy"/g).length, 4 * COMPONENTS.length);
  for (const direction of directions) assert.ok(html.includes(`data-id="${direction.id}"`));
});

test('gallery escapes the closing script sequence in embedded JSON', () => {
  const html = render(generate({ count: 1, seed: '</script>' }), { seed: '</script>' });
  const json = html.split('id="directions-data">')[1].split('</script>')[0];
  assert.ok(!json.includes('</'), 'embedded JSON can break out of its script element');
});

test('authored markup self-closes void elements so it survives the JSX rewrite', () => {
  // The DOM uncloses void elements and expands boolean attributes. Copying from
  // innerHTML instead of this source emitted JSX that would not parse.
  for (const { name, html } of COMPONENTS) {
    for (const tag of html.matchAll(/<(input|img|br|hr|meta|source)\b[^>]*>/g)) {
      assert.ok(tag[0].endsWith('/>'), `${name}: void element is not self-closed — ${tag[0]}`);
    }
  }
});

test('toJsx rewrites every reserved attribute and leaves markup parseable', () => {
  const jsx = COMPONENTS.map((c) => toJsx(c.html)).join('\n');

  assert.ok(!/\bclass=/.test(jsx), 'class= survived the rewrite');
  assert.ok(!/\bfor=/.test(jsx), 'for= survived the rewrite');
  assert.ok(!/\bchecked(?!\w)(?!Attr)/.test(jsx.replace(/defaultChecked/g, '')), 'bare checked survived');
  assert.match(jsx, /className=/);
  assert.match(jsx, /htmlFor=/);
  assert.match(jsx, /defaultChecked/);
});

test('gallery ships the component source and one shared toJsx definition', () => {
  const html = render(generate({ count: 1, seed: 'source' }));

  assert.ok(html.includes('id="components-data"'), 'component source is not embedded');
  assert.equal(html.match(/function toJsx/g).length, 1, 'toJsx is duplicated or missing');
  assert.ok(
    !html.includes("[data-markup]').innerHTML"),
    'copy path reads the DOM instead of the authored source',
  );
});
