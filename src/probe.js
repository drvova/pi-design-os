/**
 * Browser-side sources.
 *
 * `PROBE` is installed with `Page.addScriptToEvaluateOnNewDocument`, so it runs
 * in a document whose `readyState` is still `loading` and whose `body` does not
 * exist yet. That ordering is the whole point: an API wrapped after the page's
 * own scripts have run measures nothing. Everything the probe records is
 * bucketed by `document.readyState` at call time, which is exactly the
 * pre-DOM / pre-DOMContentLoaded / post-load split, taken from the platform
 * rather than from bookkeeping that could drift out of step with it.
 *
 * `HARVEST` runs once after load and reads the accumulated counters back out
 * along with the rendered design: colour, type, spacing, shape and motion,
 * sampled from computed styles and weighted by the area each value actually
 * occupies on screen.
 *
 * Neither source uses template literals, so both embed in one without escaping.
 */

/**
 * Instrumentation, installed before any page script.
 *
 * Wrappers record into `window.__designOS` and always delegate to the original.
 * A wrapper that threw would corrupt the page under measurement, so each
 * installation is isolated and any failure is pushed onto `errors` — reported,
 * never swallowed.
 */
export const PROBE = `
(function () {
  'use strict';

  var nativeAdd = EventTarget.prototype.addEventListener;
  var NativeMutationObserver = window.MutationObserver;
  var now = function () { return Math.round(performance.now() * 10) / 10; };

  var report = {
    apis: Object.create(null),
    styling: Object.create(null),
    listeners: Object.create(null),
    mutations: { loading: 0, interactive: 0, complete: 0 },
    addedTags: Object.create(null),
    removedTags: Object.create(null),
    attributes: Object.create(null),
    textEdits: { loading: 0, interactive: 0, complete: 0 },
    contexts: Object.create(null),
    preservedBuffers: 0,
    timeline: [],
    errors: []
  };

  Object.defineProperty(window, '__designOS', {
    value: report, writable: false, enumerable: false, configurable: false
  });

  function bump(bag, name) {
    var slot = bag[name];
    // firstAt turns a bare count into a point on the page's own timeline.
    if (!slot) { slot = bag[name] = { total: 0, loading: 0, interactive: 0, complete: 0, firstAt: now() }; }
    slot.total += 1;
    slot[document.readyState] += 1;
  }

  function mark(label, detail) {
    if (report.timeline.length >= 300) return;
    report.timeline.push({
      at: now(),
      phase: document.readyState,
      label: label,
      detail: detail === undefined ? null : String(detail)
    });
  }

  function guard(label, install) {
    try { install(); } catch (error) { report.errors.push('instrument ' + label + ': ' + error.message); }
  }

  // Keeps native-code sniffing honest; libraries branch on it.
  function disguise(wrapper, original) {
    guard('disguise ' + (original.name || 'anonymous'), function () {
      wrapper.toString = function () { return Function.prototype.toString.call(original); };
    });
  }

  function wrapMethod(owner, name, label, bag, note) {
    guard(label, function () {
      if (!owner) return;
      var original = owner[name];
      if (typeof original !== 'function') return;
      var wrapper = function () {
        bump(bag, label);
        if (note) {
          // A nested function() has its own arguments; capture the call's first.
          var passed = arguments;
          guard(label + ':note', function () { note(passed); });
        }
        return original.apply(this, arguments);
      };
      disguise(wrapper, original);
      owner[name] = wrapper;
    });
  }

  function wrapSetter(proto, name, label, bag) {
    guard(label, function () {
      var descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (!descriptor || typeof descriptor.set !== 'function') return;
      var original = descriptor.set;
      Object.defineProperty(proto, name, {
        get: descriptor.get,
        configurable: true,
        enumerable: descriptor.enumerable,
        set: function (value) { bump(bag, label); return original.call(this, value); }
      });
    });
  }

  // Proxy construction rather than subclassing, so prototype and instanceof survive.
  function wrapConstructor(name) {
    guard(name, function () {
      var Original = window[name];
      if (typeof Original !== 'function') return;
      window[name] = new Proxy(Original, {
        construct: function (target, args, newTarget) {
          bump(report.apis, name);
          return Reflect.construct(target, args, newTarget);
        },
        apply: function (target, thisArg, args) {
          bump(report.apis, name);
          return Reflect.apply(target, thisArg, args);
        }
      });
    });
  }

  [
    'IntersectionObserver', 'ResizeObserver', 'MutationObserver', 'PerformanceObserver',
    'ReportingObserver', 'Worker', 'SharedWorker', 'WebSocket', 'EventSource',
    'XMLHttpRequest', 'Image', 'Audio', 'FontFace', 'Notification', 'AbortController',
    'BroadcastChannel'
  ].forEach(wrapConstructor);

  [
    [window, 'fetch', 'fetch'],
    [window, 'requestAnimationFrame', 'requestAnimationFrame'],
    [window, 'requestIdleCallback', 'requestIdleCallback'],
    [window, 'matchMedia', 'matchMedia'],
    [window, 'getComputedStyle', 'getComputedStyle'],
    [window, 'setTimeout', 'setTimeout'],
    [window, 'setInterval', 'setInterval'],
    [window, 'queueMicrotask', 'queueMicrotask'],
    [window, 'scrollTo', 'scrollTo'],
    [window, 'getSelection', 'getSelection'],
    [history, 'pushState', 'history.pushState'],
    [history, 'replaceState', 'history.replaceState'],
    [navigator, 'sendBeacon', 'navigator.sendBeacon'],
    [navigator.clipboard, 'writeText', 'clipboard.writeText'],
    [Document.prototype, 'querySelector', 'querySelector'],
    [Document.prototype, 'querySelectorAll', 'querySelectorAll'],
    [Document.prototype, 'createElement', 'createElement'],
    [Document.prototype, 'elementFromPoint', 'elementFromPoint'],
    [Element.prototype, 'getBoundingClientRect', 'getBoundingClientRect'],
    [Element.prototype, 'attachShadow', 'attachShadow'],
    [Element.prototype, 'scrollIntoView', 'scrollIntoView'],
    [Element.prototype, 'insertAdjacentHTML', 'insertAdjacentHTML'],
    [Node.prototype, 'appendChild', 'appendChild'],
    [Node.prototype, 'insertBefore', 'insertBefore'],
    [Node.prototype, 'removeChild', 'removeChild'],
    [Storage.prototype, 'setItem', 'storage.setItem'],
    [Storage.prototype, 'getItem', 'storage.getItem'],
    [window.customElements, 'define', 'customElements.define'],
    [window.IntersectionObserver && window.IntersectionObserver.prototype, 'observe', 'IntersectionObserver.observe']
  ].forEach(function (entry) { wrapMethod(entry[0], entry[1], entry[2], report.apis); });

  // Canvas context type separates a 2D chart from a WebGL scene.
  //
  // A WebGL drawing buffer is cleared after compositing unless the context was
  // asked to keep it, so toDataURL on one reads back blank. The attribute can
  // only be set when the context is created, and this is the last moment before
  // any page script runs. Forcing it costs a little memory and is what makes a
  // WebGL scene survive into a clone as pixels instead of an empty element.
  guard('canvas.getContext', function () {
    if (!window.HTMLCanvasElement) return;
    var original = HTMLCanvasElement.prototype.getContext;
    var wrapper = function (type, attributes) {
      bump(report.apis, 'canvas.getContext');
      bump(report.contexts, String(type));
      var kept = attributes;
      if (/webgl|webgpu/i.test(String(type))) {
        kept = Object.assign({}, attributes || {}, { preserveDrawingBuffer: true });
        report.preservedBuffers += 1;
      }
      return original.call(this, type, kept);
    };
    disguise(wrapper, original);
    HTMLCanvasElement.prototype.getContext = wrapper;
  });

  // Every write below is styling that CSS did not do on its own.
  [
    [CSSStyleDeclaration.prototype, 'setProperty', 'style.setProperty'],
    [CSSStyleDeclaration.prototype, 'removeProperty', 'style.removeProperty'],
    [CSSStyleSheet.prototype, 'insertRule', 'stylesheet.insertRule'],
    [CSSStyleSheet.prototype, 'deleteRule', 'stylesheet.deleteRule'],
    [CSSStyleSheet.prototype, 'replaceSync', 'stylesheet.replaceSync'],
    [DOMTokenList.prototype, 'add', 'classList.add'],
    [DOMTokenList.prototype, 'remove', 'classList.remove'],
    [DOMTokenList.prototype, 'toggle', 'classList.toggle'],
    [Element.prototype, 'animate', 'Element.animate']
  ].forEach(function (entry) { wrapMethod(entry[0], entry[1], entry[2], report.styling); });

  wrapSetter(CSSStyleDeclaration.prototype, 'cssText', 'style.cssText', report.styling);
  wrapSetter(HTMLElement.prototype, 'innerText', 'innerText', report.apis);
  wrapSetter(Element.prototype, 'innerHTML', 'innerHTML', report.apis);
  wrapSetter(Document.prototype, 'adoptedStyleSheets', 'adoptedStyleSheets', report.styling);

  // setAttribute is only interesting here when the attribute drives appearance.
  guard('setAttribute', function () {
    var original = Element.prototype.setAttribute;
    var wrapper = function (name, value) {
      var lowered = String(name).toLowerCase();
      if (lowered === 'style') bump(report.styling, 'setAttribute(style)');
      else if (lowered === 'class') bump(report.styling, 'setAttribute(class)');
      else if (lowered.indexOf('data-') === 0) bump(report.styling, 'setAttribute(data-*)');
      return original.call(this, name, value);
    };
    disguise(wrapper, original);
    Element.prototype.setAttribute = wrapper;
  });

  // Listener types are the cheapest read on what drives the page at runtime.
  guard('addEventListener', function () {
    var wrapper = function (type, listener, options) {
      bump(report.listeners, String(type));
      return nativeAdd.call(this, type, listener, options);
    };
    disguise(wrapper, nativeAdd);
    EventTarget.prototype.addEventListener = wrapper;
  });

  // Observing \`document\` rather than \`documentElement\`: <html> does not exist yet.
  guard('mutation-observer', function () {
    if (typeof NativeMutationObserver !== 'function') return;
    new NativeMutationObserver(function (records) {
      var phase = document.readyState;
      for (var i = 0; i < records.length; i += 1) {
        var record = records[i];
        report.mutations[phase] += 1;
        if (record.type === 'attributes') {
          bump(report.attributes, record.attributeName);
        } else if (record.type === 'characterData') {
          report.textEdits[phase] += 1;
        } else {
          for (var a = 0; a < record.addedNodes.length; a += 1) {
            var added = record.addedNodes[a];
            if (added.nodeType === 1) bump(report.addedTags, added.tagName.toLowerCase());
          }
          for (var r = 0; r < record.removedNodes.length; r += 1) {
            var removed = record.removedNodes[r];
            if (removed.nodeType === 1) bump(report.removedTags, removed.tagName.toLowerCase());
          }
        }
      }
    }).observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
  });

  mark('probe-installed', document.readyState);
  nativeAdd.call(document, 'readystatechange', function () { mark('readystatechange', document.readyState); }, true);
  nativeAdd.call(document, 'DOMContentLoaded', function () { mark('DOMContentLoaded'); }, true);
  nativeAdd.call(window, 'load', function () { mark('load'); }, true);
  nativeAdd.call(window, 'error', function (event) {
    if (report.errors.length >= 40) return;
    var target = event.target;
    if (target && target !== window && target.tagName) {
      report.errors.push('resource failed: ' + target.tagName.toLowerCase() + ' ' + (target.src || target.href || ''));
    } else {
      report.errors.push('page error: ' + (event.message || String(event.type)));
    }
  }, true);
  nativeAdd.call(window, 'unhandledrejection', function (event) {
    if (report.errors.length < 40) report.errors.push('unhandled rejection: ' + String(event.reason).slice(0, 200));
  }, true);
})();
`;

/**
 * Post-load extraction, evaluated once with `returnByValue`.
 *
 * The probe counters are cloned on the first line, before this source touches
 * the DOM at all — otherwise harvesting would be counted as page activity and
 * inflate the very numbers it is reading.
 */
export const HARVEST = `
(function () {
  var probe = window.__designOS ? JSON.parse(JSON.stringify(window.__designOS)) : null;

  var canvas = document.createElement('canvas');
  canvas.width = 1; canvas.height = 1;
  var ctx = canvas.getContext('2d', { willReadFrequently: true });

  // Two sentinels: an unparseable value leaves fillStyle untouched, so a colour
  // is real only when both probes agree on the readback.
  function toRgba(value) {
    if (!value) return null;
    var text = String(value).trim();
    if (!text || text === 'none' || text === 'transparent' || text.indexOf('gradient') !== -1) return null;
    ctx.fillStyle = '#000000';
    ctx.fillStyle = text;
    var first = ctx.fillStyle;
    ctx.fillStyle = '#ffffff';
    ctx.fillStyle = text;
    if (ctx.fillStyle !== first) return null;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillRect(0, 0, 1, 1);
    var pixel = ctx.getImageData(0, 0, 1, 1).data;
    if (pixel[3] === 0) return null;
    return { r: pixel[0], g: pixel[1], b: pixel[2], a: Math.round((pixel[3] / 255) * 100) / 100 };
  }

  function add(bag, key, weight) {
    if (key === undefined || key === null || key === '') return;
    bag[key] = (bag[key] || 0) + weight;
  }

  function top(bag, limit) {
    return Object.keys(bag)
      .map(function (key) { return { value: key, weight: Math.round(bag[key]) }; })
      .sort(function (a, b) { return b.weight - a.weight; })
      .slice(0, limit);
  }

  var background = Object.create(null), foreground = Object.create(null), accents = Object.create(null);
  var families = Object.create(null), sizes = Object.create(null), weights = Object.create(null);
  var leading = Object.create(null), tracking = Object.create(null);
  var radii = Object.create(null), shadows = Object.create(null), borders = Object.create(null);
  var spacing = Object.create(null), durations = Object.create(null), easings = Object.create(null);
  var transforms = 0, filters = 0, sticky = 0, grids = 0, flexes = 0, animated = 0;

  // The page canvas is painted from html/body, and it is the largest surface on
  // the page. Sampling only their descendants misses the one colour a design is
  // read against; descendants are transparent far more often than not.
  // querySelectorAll stops at a shadow boundary, so on a web-component site the
  // design lives in the part of the tree a flat walk never reaches. Open roots
  // are descended into; closed ones are not reachable from script.
  var body = document.body;
  var descendants = [];
  var total = 0;
  if (body) {
    (function gather(root, depth) {
      var nodes = root.querySelectorAll('*');
      total += nodes.length;
      if (depth > 12) return;
      for (var g = 0; g < nodes.length; g += 1) {
        if (descendants.length < 3000) descendants.push(nodes[g]);
        if (nodes[g].shadowRoot) gather(nodes[g].shadowRoot, depth + 1);
      }
    })(body, 0);
  }
  // Two kinds of element are discounted, both for the same reason: a copy is
  // scored against this count, and neither side should be credited or charged
  // for something the copy is not meant to reproduce.
  //
  // Style elements this tool materialises are its own scaffolding. Resource
  // hints are stripped from a clone deliberately, since they would 404 against
  // it — and a page can inject them by the hundred after load, which is how
  // framer.com came out 106 elements short while every other measure matched.
  // A link element renders nothing, and a page can inject dozens into its body
  // while it runs: notion.com adds eighteen, which a copy with its scripts off
  // can never have. Counting them measures loading metadata rather than
  // structure, so none of them count on either side. Style elements this tool
  // materialises are discounted for the same reason — neither side should be
  // charged for something the copy is not meant to reproduce.
  //
  // Only links inside the body, because the count above is a walk from the body:
  // a link in the head was never in it. Subtracting head hints as well -- tried,
  // on the strength of a histogram that walked documentElement instead and so
  // agreed with the guess -- charges the original for elements it never counted,
  // and made retool.com worse rather than better.
  total -= document.querySelectorAll('style[data-design-os]').length + body.querySelectorAll('link').length;
  var all = body ? [document.documentElement, body].concat(descendants) : [];
  var sampled = 0;
  var viewport = Math.max(1, window.innerWidth * window.innerHeight);

  for (var i = 0; i < all.length; i += 1) {
    var element = all[i];
    var style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

    var rect = element.getBoundingClientRect();
    var area = rect.width * rect.height;
    if (area <= 0) continue;
    sampled += 1;

    // Area weighting: a hero background outranks a one-pixel divider. The cap
    // stops one very tall element on a long page from erasing everything else.
    var weight = Math.min(500, Math.max(1, Math.round((area / viewport) * 100)));
    var text = (element.textContent || '').trim().length > 0;

    var bg = toRgba(style.backgroundColor);
    if (bg && bg.a > 0.15) add(background, bg.r + ',' + bg.g + ',' + bg.b, weight);
    var fg = toRgba(style.color);
    if (fg && text) add(foreground, fg.r + ',' + fg.g + ',' + fg.b, Math.min(weight, 20) + 1);

    // Buttons, links and marked controls carry a site's accent more reliably than body copy.
    var tag = element.tagName;
    if (tag === 'A' || tag === 'BUTTON' || element.getAttribute('role') === 'button') {
      if (bg && bg.a > 0.15) add(accents, bg.r + ',' + bg.g + ',' + bg.b, 40);
      if (fg) add(accents, fg.r + ',' + fg.g + ',' + fg.b, 15);
    }

    if (text) {
      add(families, style.fontFamily.split(',')[0].replace(/["']/g, '').trim(), weight);
      add(sizes, style.fontSize, 1);
      add(weights, style.fontWeight, 1);
      add(leading, style.lineHeight, 1);
      if (style.letterSpacing !== 'normal') add(tracking, style.letterSpacing, 1);
    }

    if (style.borderRadius !== '0px') add(radii, style.borderRadius, 1);
    if (style.boxShadow !== 'none') add(shadows, style.boxShadow, 1);
    if (parseFloat(style.borderTopWidth) > 0) add(borders, style.borderTopWidth + ' ' + style.borderTopStyle, 1);
    if (style.paddingTop !== '0px') add(spacing, style.paddingTop, 1);
    if (style.gap && style.gap !== 'normal' && style.gap !== '0px') add(spacing, style.gap, 1);
    if (style.transitionDuration !== '0s') { add(durations, style.transitionDuration, 1); add(easings, style.transitionTimingFunction, 1); }
    if (style.animationName !== 'none') animated += 1;
    if (style.transform !== 'none') transforms += 1;
    if (style.filter !== 'none' || style.backdropFilter && style.backdropFilter !== 'none') filters += 1;
    if (style.position === 'sticky' || style.position === 'fixed') sticky += 1;
    if (style.display === 'grid' || style.display === 'inline-grid') grids += 1;
    if (style.display === 'flex' || style.display === 'inline-flex') flexes += 1;
  }

  // Authored custom properties are a design system stated outright rather than inferred.
  var rootStyle = window.getComputedStyle(document.documentElement);
  var custom = {};

  var globals = Object.getOwnPropertyNames(window);
  function has(name) { return globals.indexOf(name) !== -1; }
  function present(selector) { return !!document.querySelector(selector); }
  function anyKey(pattern) {
    var root = document.body || document.documentElement;
    if (!root) return false;
    var keys = Object.keys(root);
    for (var k = 0; k < keys.length; k += 1) if (pattern.test(keys[k])) return true;
    return false;
  }

  var signals = [
    ['React', has('__REACT_DEVTOOLS_GLOBAL_HOOK__') || anyKey(/^__reactContainer\\$|^__reactFiber\\$/) || present('[data-reactroot]')],
    ['Next.js', has('__NEXT_DATA__') || has('next') || present('#__next') || present('script#__NEXT_DATA__')],
    ['Remix', has('__remixContext')],
    ['Gatsby', has('___gatsby')],
    ['Vue', has('__VUE__') || has('__VUE_DEVTOOLS_GLOBAL_HOOK__') || present('[data-v-app]')],
    ['Nuxt', has('__NUXT__') || has('$nuxt')],
    ['Svelte', has('__svelte') || present('[class*="svelte-"]')],
    ['SvelteKit', has('__sveltekit_dev') || present('script[data-sveltekit-fetched]') || anyKey(/^__sveltekit/)],
    ['Angular', has('ng') || has('getAllAngularRootElements') || present('[ng-version]')],
    ['Astro', present('astro-island') || present('[astro-source-file]') || has('$$astro')],
    ['SolidJS', has('_$HY')],
    ['Qwik', present('[q\\\\:container]')],
    ['HTMX', has('htmx')],
    ['Alpine.js', has('Alpine')],
    ['Stimulus', has('Stimulus') || present('[data-controller]')],
    ['jQuery', has('jQuery') || has('$') && typeof window.$ === 'function' && !!window.$.fn],
    ['Web Components', document.querySelectorAll('*').length > 0 && Array.prototype.some.call(document.querySelectorAll('*'), function (el) { return el.tagName.indexOf('-') !== -1; })],
    ['Tailwind CSS', present('[class*="flex"][class*="items-"]') || present('[class*="text-"][class*="bg-"]') || (custom['--tw-ring-offset-shadow'] !== undefined)],
    ['styled-components', present('style[data-styled]') || present('[class^="sc-"]')],
    ['Emotion', present('style[data-emotion]') || present('[class*="css-"]')],
    ['CSS Modules', present('[class*="_"][class*="__"]')],
    ['GSAP', has('gsap') || has('TweenMax') || has('ScrollTrigger')],
    ['Framer Motion', present('[data-framer-name]') || has('__framer_importFromPackage')],
    ['Three.js', has('THREE')],
    ['Lenis', has('Lenis') || present('html.lenis')],
    ['Locomotive Scroll', has('LocomotiveScroll') || present('[data-scroll-container]')],
    ['Lottie', has('lottie') || present('lottie-player')],
    ['Swiper', has('Swiper') || present('.swiper')],
    ['Google Analytics', has('gtag') || has('dataLayer') || has('ga')],
    ['Segment', has('analytics')],
    ['Sentry', has('__SENTRY__')],
    ['Google Fonts', present('link[href*="fonts.googleapis"], link[href*="fonts.gstatic"]')],
    ['Shopify', has('Shopify')],
    ['WordPress', present('link[href*="wp-content"], script[src*="wp-includes"]')],
    ['Webflow', has('Webflow') || present('html[data-wf-page]')],
    ['Framer', present('#main[data-framer-hydrate-v2]') || present('[data-framer-page-optimized-at]')]
  ];

  var stack = [];
  for (var s = 0; s < signals.length; s += 1) if (signals[s][1]) stack.push(signals[s][0]);

  // Authored assets, still in source order.
  // Same-origin destinations, read after hydration so client-rendered links
  // count. The hash is dropped: one document serves every fragment of itself.
  var links = [];
  var seenLinks = Object.create(null);
  var anchors = document.querySelectorAll('a[href]');
  for (var n = 0; n < anchors.length && links.length < 500; n += 1) {
    var href = anchors[n].href;
    if (!href || href.lastIndexOf(location.origin, 0) !== 0) continue;
    var clean = href.split('#')[0];
    if (!clean || seenLinks[clean]) continue;
    seenLinks[clean] = 1;
    links.push(clean);
  }

  var sheets = Array.prototype.map.call(document.querySelectorAll('link[rel~="stylesheet"]'), function (link) {
    return { href: link.href, media: link.media || 'all', disabled: link.disabled };
  });
  var scripts = Array.prototype.map.call(document.scripts, function (script) {
    return {
      src: script.src || null,
      type: script.type || 'classic',
      async: script.async,
      defer: script.defer,
      module: script.type === 'module',
      inlineBytes: script.src ? 0 : script.textContent.length
    };
  });

  var depth = 0;
  for (var d = 0; d < descendants.length; d += 1) {
    var level = 0, node = descendants[d];
    while (node.parentElement) { level += 1; node = node.parentElement; }
    if (level > depth) depth = level;
  }

  return {
    probe: probe,
    stack: stack,
    design: {
      background: top(background, 10),
      foreground: top(foreground, 8),
      accents: top(accents, 8),
      families: top(families, 6),
      sizes: top(sizes, 10),
      weights: top(weights, 6),
      leading: top(leading, 5),
      tracking: top(tracking, 4),
      radii: top(radii, 6),
      shadows: top(shadows, 5),
      borders: top(borders, 4),
      spacing: top(spacing, 10),
      durations: top(durations, 5),
      easings: top(easings, 5),
      customProperties: custom
    },
    layout: {
      sampled: sampled,
      elements: total,
      maxDepth: depth,
      grids: grids,
      flexes: flexes,
      sticky: sticky,
      transformed: transforms,
      filtered: filters,
      keyframeAnimated: animated
    },
    assets: { stylesheets: sheets, scripts: scripts },
    links: links,
    document: {
      title: document.title,
      lang: document.documentElement.lang || null,
      charset: document.characterSet,
      url: location.href,
      colorScheme: rootStyle.colorScheme || null
    }
  };
})();
`;

/**
 * Resolves named custom properties against `:root`.
 *
 * `getComputedStyle` does not enumerate custom properties in Chrome, so the
 * names cannot be discovered from the page. They are read out of the stylesheet
 * text the CSS domain already returned — which also sidesteps the CORS wall that
 * blocks `cssRules` on a cross-origin sheet — and resolved here by name, so the
 * value recorded is the one that actually applies after `var()` substitution.
 *
 * @param {string[]} names custom property names, including the leading `--`
 */
export const resolveTokens = (names) => `
(function () {
  var names = ${JSON.stringify(names)};
  var style = getComputedStyle(document.documentElement);
  var resolved = {};
  for (var i = 0; i < names.length; i += 1) {
    var value = style.getPropertyValue(names[i]).trim();
    if (value) resolved[names[i]] = value.length > 120 ? value.slice(0, 120) + '…' : value;
  }
  return resolved;
})();
`;

/**
 * Serializes the live document for cloning.
 *
 * `outerHTML` reads element text, but `insertRule` writes to the CSSOM without
 * ever touching the `<style>` element it belongs to. Every CSS-in-JS rule is
 * therefore invisible to serialization — on a styled-components site that is the
 * entire stylesheet, and the clone would render unstyled. Each inline sheet is
 * written back to its owner node first, and constructed sheets held only in
 * `adoptedStyleSheets` are materialised into a `<style>` of their own.
 *
 * Field state lives in properties rather than attributes for the same reason, so
 * what the user sees in an input is mirrored onto the attribute that serializes.
 *
 * Shadow roots are invisible to `outerHTML` too, which clones a web-component
 * site as a page of empty custom elements. Open roots are collected and handed
 * to `getHTML`, which writes them as the declarative `<template shadowrootmode>`
 * a browser parses straight back. Closed roots are unreachable by design; they
 * are counted so the gap is stated rather than found later.
 */
export const SNAPSHOT = `
(function () {
  var notes = {
    inlineSheets: 0, adoptedSheets: 0, rules: 0, unreadable: 0, fields: 0,
    shadowRoots: 0, closedHosts: 0, canvases: 0, canvasBytes: 0, animations: 0, posters: 0,
  };

  function kebab(property) { return property.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); }); }

  // Constructed sheets attached to a root are materialised into it, so a shadow
  // tree keeps its styling once serialized.
  function adopt(root, label) {
    var sheets = root.adoptedStyleSheets || [];
    for (var i = 0; i < sheets.length; i += 1) {
      try {
        var rules = sheets[i].cssRules;
        if (!rules || rules.length === 0) continue;
        var text = [];
        for (var r = 0; r < rules.length; r += 1) text.push(rules[r].cssText);
        var style = document.createElement('style');
        style.setAttribute('data-design-os', label);
        style.textContent = text.join('\\n');
        (root === document ? document.head : root).appendChild(style);
        notes.adoptedSheets += 1;
        notes.rules += rules.length;
      } catch (error) {
        notes.unreadable += 1;
      }
    }
  }

  for (var i = 0; i < document.styleSheets.length; i += 1) {
    var sheet = document.styleSheets[i];
    var owner = sheet.ownerNode;
    if (!owner || owner.tagName !== 'STYLE') continue;
    try {
      var rules = sheet.cssRules;
      if (!rules || rules.length === 0) continue;
      var text = [];
      for (var r = 0; r < rules.length; r += 1) text.push(rules[r].cssText);
      owner.textContent = text.join('\\n');
      notes.inlineSheets += 1;
      notes.rules += rules.length;
    } catch (error) {
      notes.unreadable += 1;
    }
  }

  adopt(document, 'adopted');

  // Open roots only; a closed root cannot be reached from script by design.
  var roots = [];
  (function descend(node, depth) {
    if (depth > 12 || roots.length > 2000) return;
    var elements = node.querySelectorAll('*');
    for (var e = 0; e < elements.length; e += 1) {
      var host = elements[e];
      if (!host.shadowRoot) {
        if (host.tagName.indexOf('-') !== -1) notes.closedHosts += 1;
        continue;
      }
      roots.push(host.shadowRoot);
      adopt(host.shadowRoot, 'adopted-shadow');
      descend(host.shadowRoot, depth + 1);
    }
  })(document, 0);
  notes.shadowRoots = roots.length;

  // A canvas paints through an API, and the API is gone once scripts are off.
  // What can be kept is the last frame it painted, read back as an image and
  // set as the element's own background so it renders at the same size.
  var canvases = document.querySelectorAll('canvas');
  for (var c = 0; c < canvases.length; c += 1) {
    var canvas = canvases[c];
    if (!canvas.width || !canvas.height) continue;
    try {
      var frame = canvas.toDataURL('image/png');
      // A blank canvas serialises to a few dozen bytes; keeping those would
      // overwrite a background the stylesheet may already provide.
      if (frame.length < 512) continue;
      canvas.setAttribute('data-design-os', 'canvas-frame');
      canvas.style.backgroundImage = 'url(' + frame + ')';
      canvas.style.backgroundSize = '100% 100%';
      canvas.style.backgroundRepeat = 'no-repeat';
      notes.canvases += 1;
      notes.canvasBytes += frame.length;
    } catch (error) {
      // A canvas tainted by a cross-origin draw cannot be read back at all.
      notes.unreadable += 1;
    }
  }

  // A video holds a frame the same way, and a poster survives where playback
  // cannot. Drawing it needs a same-origin source, so a tainted one is skipped.
  var videos = document.querySelectorAll('video');
  for (var v = 0; v < videos.length; v += 1) {
    var video = videos[v];
    if (video.getAttribute('poster') || !video.videoWidth) continue;
    try {
      var still = document.createElement('canvas');
      still.width = video.videoWidth;
      still.height = video.videoHeight;
      still.getContext('2d').drawImage(video, 0, 0);
      video.setAttribute('poster', still.toDataURL('image/jpeg', 0.8));
      notes.posters += 1;
    } catch (error) {
      notes.unreadable += 1;
    }
  }

  // Element.animate produces animations the CSSOM never sees, so serialization
  // loses them entirely. Each script-driven one is rewritten as the @keyframes
  // and shorthand it is equivalent to; a CSSAnimation or CSSTransition already
  // has a rule behind it and is left alone.
  if (typeof document.getAnimations === 'function') {
    var css = [];
    var running = document.getAnimations();
    for (var a = 0; a < running.length && css.length < 200; a += 1) {
      try {
        var animation = running[a];
        if (animation.constructor && animation.constructor.name !== 'Animation') continue;
        var effect = animation.effect;
        if (!effect || !effect.target || typeof effect.getKeyframes !== 'function') continue;

        var frames = effect.getKeyframes();
        if (frames.length === 0) continue;
        var timing = effect.getTiming();
        var name = 'design-os-anim-' + notes.animations;

        var steps = [];
        for (var f = 0; f < frames.length; f += 1) {
          var keyframe = frames[f];
          var declarations = [];
          for (var property in keyframe) {
            if (property === 'offset' || property === 'computedOffset' || property === 'easing' || property === 'composite') continue;
            if (keyframe[property] === null || keyframe[property] === undefined) continue;
            declarations.push(kebab(property) + ':' + keyframe[property]);
          }
          if (declarations.length === 0) continue;
          var at = Math.round((keyframe.computedOffset !== undefined ? keyframe.computedOffset : f / Math.max(1, frames.length - 1)) * 100);
          steps.push(at + '% { ' + declarations.join(';') + ' }');
        }
        if (steps.length === 0) continue;

        effect.target.setAttribute('data-design-os-anim', name);
        var duration = typeof timing.duration === 'number' ? timing.duration : 0;
        var shorthand = [
          name,
          duration + 'ms',
          timing.easing || 'linear',
          (timing.delay || 0) + 'ms',
          timing.iterations === Infinity ? 'infinite' : (timing.iterations || 1),
          timing.direction || 'normal',
          timing.fill && timing.fill !== 'auto' ? timing.fill : 'both',
        ].join(' ');

        css.push('@keyframes ' + name + ' { ' + steps.join(' ') + ' }');
        css.push('[data-design-os-anim="' + name + '"] { animation: ' + shorthand + '; }');
        notes.animations += 1;
      } catch (error) {
        notes.unreadable += 1;
      }
    }

    if (css.length > 0) {
      var sheet = document.createElement('style');
      sheet.setAttribute('data-design-os', 'animations');
      sheet.textContent = css.join('\\n');
      document.head.appendChild(sheet);
    }
  }

  var fields = document.querySelectorAll('input, textarea, select option');
  for (var f = 0; f < fields.length; f += 1) {
    var field = fields[f];
    if (field.tagName === 'OPTION') {
      if (field.selected) { field.setAttribute('selected', ''); notes.fields += 1; }
    } else if (field.type === 'checkbox' || field.type === 'radio') {
      if (field.checked) { field.setAttribute('checked', ''); notes.fields += 1; }
    } else if (field.value) {
      field.setAttribute('value', field.value);
      notes.fields += 1;
    }
  }

  // getHTML serializes an element's children, the way innerHTML does, so the
  // <html> element has to be rebuilt around it. Its attributes are not
  // decoration: framework theme and font-variable classes live there, and a
  // clone that drops them falls back to system fonts everywhere.
  var root = document.documentElement;
  // Move out of <head> anything a parser will not accept there.
  //
  // A script can put any node in the head through the DOM, and the DOM keeps it:
  // webflow's analytics puts a hidden iframe there. Serializing that and reading
  // it back does not round-trip, because the parser enforces what the DOM did
  // not — it closes <head> at the iframe and everything after it becomes body
  // content. On webflow.com that moved the charset declaration, the title and
  // twelve stylesheet links into <body>, and a charset outside the head's first
  // bytes is not honoured at all.
  //
  // The offending node is kept, not dropped, and placed where a parser accepts
  // it, so the copy holds the same nodes and reparses to the same shape.
  var HEAD_ALLOWS = { BASE: 1, LINK: 1, META: 1, NOSCRIPT: 1, SCRIPT: 1, STYLE: 1, TEMPLATE: 1, TITLE: 1 };
  var relocated = 0;
  if (document.head && document.body) {
    var stray = [];
    for (var h = 0; h < document.head.children.length; h++) {
      var child = document.head.children[h];
      if (!HEAD_ALLOWS[child.tagName]) stray.push(child);
    }
    // A fragment keeps their order when they arrive at the top of the body.
    if (stray.length > 0) {
      var moving = document.createDocumentFragment();
      for (var m = 0; m < stray.length; m++) {
        stray[m].setAttribute('data-design-os', 'moved-from-head');
        moving.appendChild(stray[m]);
      }
      document.body.insertBefore(moving, document.body.firstChild);
      relocated = stray.length;
    }
  }
  notes.relocatedFromHead = relocated;

  var markup;
  if (typeof root.getHTML === 'function') {
    var open = '';
    for (var n = 0; n < root.attributes.length; n += 1) {
      var attribute = root.attributes[n];
      var quoted = String(attribute.value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      open += ' ' + attribute.name + '="' + quoted + '"';
    }
    markup = '<html' + open + '>' + root.getHTML({ serializableShadowRoots: true, shadowRoots: roots }) + '</html>';
  } else {
    markup = root.outerHTML;
  }

  return { html: '<!doctype html>\\n' + markup, notes: notes };
})();
`;

/**
 * Slice detection, run before the page is serialized.
 *
 * A cloned page has no business domains, so slices are inferred from what the
 * markup actually states. Landmarks are widgets, explicit interactive roles are
 * features, repeated sibling subtrees are entities, and leaf controls are shared
 * primitives. Nothing here guesses from appearance: every rule keys off a tag,
 * a role, or a repetition the DOM itself contains.
 *
 * Each root is marked with an attribute so the CSS domain can resolve matched
 * rules against the exact nodes afterwards, and so the boundary stays visible in
 * the cloned markup.
 */
export const SLICES = `
(function () {
  var MARKER = 'data-design-os-slice';
  var WIDGET_TAGS = { HEADER: 'site-header', FOOTER: 'site-footer', NAV: 'nav', ASIDE: 'sidebar' };
  var FEATURE_TAGS = { FORM: 'form', DIALOG: 'dialog', DETAILS: 'disclosure' };
  var FEATURE_ROLES = { dialog: 'dialog', menu: 'menu', tablist: 'tabs', switch: 'switch', search: 'search' };
  var PRIMITIVE_TAGS = { BUTTON: 'button', INPUT: 'input', SELECT: 'select', TEXTAREA: 'textarea', SVG: 'icon' };

  var found = [];
  var claimed = new Set();
  var used = Object.create(null);

  // A utility class describes appearance, not identity. On a Tailwind site every
  // element carries a dozen, and naming a component after one produces
  // widgets/mb-32 for the page header.
  var UTILITY_WORD = /^(flex|grid|block|inline|inline-block|contents|hidden|relative|absolute|fixed|sticky|static|group|peer|container|truncate|italic|bold|underline|uppercase|lowercase|capitalize|rounded|border|shadow|overflow|isolate|transform|transition|antialiased|cursor|select|pointer|invisible|visible|sr-only|not-prose|prose)([-_].*)?$/;
  var UTILITY_SHAPE = /^-?[a-z]{1,8}-(\\d|\\[|full$|none$|auto$|px$|screen$|min$|max$|xs$|sm$|md$|lg$|xl$|\\dxl$)/;

  // A shape test separates mb-32 from post-card but not items-center from it,
  // because both are two words. What does separate them is that the first word
  // of a utility names a css property, and that set is finite.
  var UTILITY_PREFIX = new Set(
    ('items justify content self place order basis grow shrink flex grid col row gap space ' +
     'w h size min max aspect columns p px py pt pb pl pr m mx my mt mb ml mr inset top right bottom left ' +
     'bg text font leading tracking whitespace indent align decoration underline line list ' +
     'border rounded divide outline ring shadow opacity mix blend ' +
     'translate rotate scale skew origin transform transition duration delay ease animate will ' +
     'overflow overscroll object float clear isolation z ' +
     'fill stroke backdrop blur brightness contrast grayscale saturate sepia invert ' +
     'cursor pointer resize scroll snap touch select caret accent appearance ' +
     'sr not table caption border-spacing').split(' '),
  );

  function isUtility(name) {
    if (name.indexOf(':') !== -1 || UTILITY_WORD.test(name) || UTILITY_SHAPE.test(name)) return true;
    return UTILITY_PREFIX.has(name.split('-')[0]);
  }

  // Framework-generated ids change between renders, so a slice named after one
  // would not survive a second capture of the same page.
  var GENERATED_ID = /^(radix-|headlessui-|react-aria|mui-|rc-|:r|_|\\d)|^r[a-z0-9]{1,4}$|^[a-z]{1,2}$/i;

  function kebab(text) {
    return String(text)
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
  }

  // A CSS-module class looks like PostCard_root__a1b2. The author's component
  // name is the first part; what follows the underscore names the element
  // inside it, so PostCard_root and PostCard_title are one component.
  function moduleName(element) {
    var classes = String(element.className && element.className.baseVal !== undefined ? element.className.baseVal : element.className || '').split(/\\s+/).filter(Boolean);
    // An element carrying this many classes is being styled by utilities, and
    // picking one of them names the component after an accident of layout.
    var utilityHeavy = classes.length >= 5;
    for (var i = 0; i < classes.length; i += 1) {
      var match = /^([A-Za-z][A-Za-z0-9]*)(?:_[A-Za-z0-9]+)?__[A-Za-z0-9_-]{4,}$/.exec(classes[i]);
      if (match) return match[1];
    }
    for (var c = 0; c < classes.length && !utilityHeavy; c += 1) {
      var plain = classes[c];
      if (plain.length < 4 || plain.length > 28) continue;
      if (!/^[a-z][a-z0-9-]*$/.test(plain) || isUtility(plain)) continue;
      // A name worth keeping reads as a name: two or more words, or one long one.
      if (plain.indexOf('-') !== -1 || plain.length >= 8) return plain;
    }
    return null;
  }

  // An id or a label names the instance, not the kind, so the tag is appended
  // to say what the thing is: subscribe becomes subscribe-form. A class is
  // already the author's component name and is left alone.
  function withKind(name, element) {
    var tag = element.tagName.toLowerCase();
    return name.indexOf(tag) === -1 ? kebab(name + '-' + tag) : name;
  }

  // What a block says about itself, when nothing names it. Only ever used for
  // singletons: the text inside a repeated unit differs per instance, so naming
  // a card component after the first card's title would be wrong.
  function contentName(element) {
    // Only a heading the block owns. A descendant's aria-label names that
    // descendant: borrowing it turns a header wrapping a nav into primary-header.
    var heading = element.querySelector('h1,h2,h3,h4,h5,h6,figcaption,summary,legend');
    if (!heading) return null;
    var text = (heading.textContent || '').trim();
    return text && text.length <= 40 ? kebab(text) : null;
  }

  function nameFor(element, fallback, useContent) {
    if (element.id && !GENERATED_ID.test(element.id)) {
      return { name: withKind(kebab(element.id), element), namedBy: 'id' };
    }
    var label = element.getAttribute('aria-label');
    if (label) return { name: withKind(kebab(label), element), namedBy: 'aria-label' };
    var module = moduleName(element);
    if (module) return { name: kebab(module), namedBy: 'class' };
    if (useContent) {
      var described = contentName(element);
      if (described) return { name: withKind(described, element), namedBy: 'content' };
    }
    return { name: kebab(fallback), namedBy: 'tag' };
  }

  function unique(layer, name) {
    var key = layer + '/' + (name || 'unnamed');
    if (!used[key]) { used[key] = 1; return name || 'unnamed'; }
    used[key] += 1;
    return (name || 'unnamed') + '-' + used[key];
  }

  // Tag, classes and immediate child shape. Two siblings that agree on all three
  // are the same component rendered twice.
  function signature(element) {
    var classes = String(element.getAttribute('class') || '').split(/\\s+/).filter(Boolean).sort().join('.');
    var shape = [];
    for (var i = 0; i < element.children.length; i += 1) shape.push(element.children[i].tagName);
    return element.tagName + '|' + classes + '|' + shape.join(',');
  }

  function claim(element, layer, name, namedBy, instances) {
    if (claimed.has(element)) return;
    claimed.add(element);
    var base = name || 'unnamed';
    var slug = unique(layer, base);
    element.setAttribute(MARKER, layer + '/' + slug);
    found.push({
      layer: layer,
      base: base,
      name: slug,
      namedBy: namedBy,
      tag: element.tagName.toLowerCase(),
      instances: instances || 1,
      descendants: element.querySelectorAll('*').length,
      signature: signature(element),
      marker: layer + '/' + slug
    });
  }

  var all = document.body ? document.body.querySelectorAll('*') : [];

  // Widgets: page landmarks, plus custom elements substantial enough to be one.
  for (var w = 0; w < all.length; w += 1) {
    var node = all[w];
    var landmark = WIDGET_TAGS[node.tagName];
    if (landmark) {
      // A landmark directly under body is the page's own, and its role is a
      // better name than anything inside it. One nested in an article is a
      // component, where a heading says far more than the tag does.
      var named = nameFor(node, landmark, node.parentElement !== document.body);
      claim(node, 'widgets', named.namedBy === 'tag' ? landmark : named.name, named.namedBy);
    } else if (node.tagName.indexOf('-') !== -1 && node.querySelectorAll('*').length >= 3) {
      claim(node, 'widgets', kebab(node.tagName), 'custom-element');
    }
  }

  // Features: interaction the markup declares outright.
  for (var f = 0; f < all.length; f += 1) {
    var candidate = all[f];
    var role = String(candidate.getAttribute('role') || '').toLowerCase();
    var kind = FEATURE_TAGS[candidate.tagName] || FEATURE_ROLES[role];
    if (!kind) continue;
    var featureName = nameFor(candidate, kind, true);
    claim(candidate, 'features', featureName.name || kind, featureName.namedBy);
  }

  // Entities: a subtree the page repeats among siblings is a rendered unit.
  var parents = new Set();
  for (var p = 0; p < all.length; p += 1) if (all[p].parentElement) parents.add(all[p].parentElement);
  parents.forEach(function (parent) {
    var groups = Object.create(null);
    for (var c = 0; c < parent.children.length; c += 1) {
      var child = parent.children[c];
      // Three descendants is the line between a repeated component and a pair
      // of styled spans, which a content page produces by the dozen.
      if (child.querySelectorAll('*').length < 3) continue;
      var key = signature(child);
      (groups[key] = groups[key] || []).push(child);
    }
    Object.keys(groups).forEach(function (key) {
      var group = groups[key];
      if (group.length < 2) return;
      var exemplar = group[0];
      if (claimed.has(exemplar)) return;
      var entityName = nameFor(exemplar, exemplar.tagName + '-item');
      // An unnameable repetition is a layout accident, not a component.
      if (entityName.namedBy === 'tag' && exemplar.querySelectorAll('*').length < 6) return;
      claim(exemplar, 'entities', entityName.name, entityName.namedBy, group.length);
    });
  });

  // Shared primitives: one folder per distinct leaf control, not per occurrence.
  var primitives = Object.create(null);
  for (var s = 0; s < all.length; s += 1) {
    var leaf = all[s];
    var primitive = PRIMITIVE_TAGS[leaf.tagName] || (leaf.getAttribute('role') === 'button' ? 'button' : null);
    if (!primitive || claimed.has(leaf)) continue;
    var key = primitive + '|' + signature(leaf);
    if (!primitives[key]) primitives[key] = [];
    primitives[key].push(leaf);
  }
  Object.keys(primitives).forEach(function (key) {
    var group = primitives[key];
    var exemplar = group[0];
    // A primitive is named by what it is for, never by how it is styled: its
    // label or its id, and otherwise just the control it is.
    var kind = PRIMITIVE_TAGS[exemplar.tagName] || 'control';
    var label = exemplar.getAttribute('aria-label');
    var primitiveName = { name: kebab(kind), namedBy: 'tag' };
    if (exemplar.id && !GENERATED_ID.test(exemplar.id)) {
      primitiveName = { name: withKind(kebab(exemplar.id), exemplar), namedBy: 'id' };
    } else if (label) {
      primitiveName = { name: withKind(kebab(label), exemplar), namedBy: 'aria-label' };
    }
    claim(exemplar, 'shared', primitiveName.name, primitiveName.namedBy, group.length);
  });

  // The document shell is not decoration. A theme class sits on <html> and a
  // font-loader class sits on <body>; a preview that invents its own bare shell
  // renders every component in the fallback serif.
  function shellOf(element) {
    var attributes = {};
    for (var a = 0; a < element.attributes.length; a += 1) {
      attributes[element.attributes[a].name] = element.attributes[a].value;
    }
    return attributes;
  }

  return {
    shell: { html: shellOf(document.documentElement), body: shellOf(document.body) },
    slices: found.map(function (slice) {
      var element = document.querySelector('[' + MARKER + '="' + slice.marker + '"]');
      slice.html = element ? element.outerHTML : '';
      slice.text = element ? (element.textContent || '').trim().slice(0, 80) : '';
      return slice;
    }),
  };
})();
`;

/**
 * Walks the page so everything that waits for a viewport has happened.
 *
 * A page built with `IntersectionObserver` and `loading="lazy"` only renders
 * what has been near the viewport. Capturing without scrolling copies the top of
 * the page and leaves the rest as empty placeholders that will never fill,
 * because the observers are gone once the scripts are disabled.
 *
 * Evaluated with `awaitPromise`, and bounded: a page that grows as it is
 * scrolled would otherwise never end.
 */
export const REVEAL = `
(function () {
  var MAX_STEPS = 60;
  var STEP_MS = 90;
  var start = performance.now();
  var steps = 0;

  function rest(ms) { return new Promise(function (done) { setTimeout(done, ms); }); }

  return (async function () {
    var previousHeight = 0;
    for (; steps < MAX_STEPS; steps += 1) {
      var height = document.documentElement.scrollHeight;
      var target = Math.min(steps * window.innerHeight * 0.8, height);
      window.scrollTo(0, target);
      await rest(STEP_MS);
      // Stop once the bottom is reached and the page has stopped growing.
      if (target >= height && height === previousHeight) break;
      previousHeight = height;
    }

    window.scrollTo(0, 0);
    await rest(STEP_MS);

    // Images requested during the walk are still in flight; a clone of a
    // half-decoded image is a clone of nothing.
    var pending = Array.prototype.filter.call(document.images, function (image) { return !image.complete; });
    await Promise.race([
      Promise.all(pending.map(function (image) {
        return new Promise(function (done) {
          image.addEventListener('load', done, { once: true });
          image.addEventListener('error', done, { once: true });
        });
      })),
      rest(4000),
    ]);

    if (document.fonts && document.fonts.ready) await Promise.race([document.fonts.ready, rest(2000)]);

    return {
      steps: steps,
      height: document.documentElement.scrollHeight,
      imagesAwaited: pending.length,
      elapsed: Math.round(performance.now() - start),
    };
  })();
})();
`;

/**
 * Which rules apply inside each marked slice, resolved in one pass.
 *
 * Asking the CSS domain per node is exact but costs one round trip each, and on
 * a page of this size that measured 80ms a call: fifty slices of a few hundred
 * nodes is twenty thousand calls, which is twenty-six minutes of waiting that
 * looks indistinguishable from a hang.
 *
 * Inverted, it is one pass over the rules instead. The browser's own selector
 * engine answers "what does this rule match" once per rule, and each match is
 * walked up to the slices that contain it — so every node is still considered,
 * with no sampling, and the whole thing is a single evaluation.
 *
 * A rule is attributed to every enclosing slice, not just the nearest: a button
 * inside a header belongs to the button's own folder and to the header's.
 */
export const MATCH_SLICES = `
(function () {
  var MARKER = 'data-design-os-slice';

  // Pseudo-elements cannot be matched, and a dynamic pseudo-class would match
  // nothing right now even though the rule is part of the component. Both are
  // stripped for the purpose of finding the rule's targets.
  var DYNAMIC = /::?(?:before|after|placeholder|selection|backdrop|marker|first-line|first-letter|file-selector-button|-webkit-[a-z-]+)|:(?:hover|focus|focus-visible|focus-within|active|visited|target|any-link|autofill)\\b/g;

  // An interactive state is the same problem as :hover. A rule written for a menu
  // that is open matches nothing while it is closed, even though it is plainly
  // part of that menu: lawsofux.com styles its toggle icons through
  // [aria-expanded="true"], and those four rules never reached the component.
  //
  // Only attributes that express a toggle are removed. aria-hidden and
  // aria-disabled are deliberately left in place — stripping those widens a
  // selector to content the component does not own, which would attribute rules
  // to slices they have nothing to do with.
  var STATE = /\\[(?:aria-(?:expanded|selected|checked|pressed|current)|data-(?:state|open|active|selected|expanded|highlighted)|open)(?:[~^$*|]?=(?:"[^"]*"|'[^']*'|[^\\]]*))?\\]/gi;

  function targetable(selector) {
    var stripped = selector.replace(DYNAMIC, '').replace(STATE, '').replace(/\\s*[>+~]\\s*$/, '').trim();
    return stripped === '' ? null : stripped;
  }

  function query(selector) {
    try { return document.querySelectorAll(selector); } catch (error) { return null; }
  }

  var flat = [];
  function walk(rules, conditions) {
    for (var i = 0; i < rules.length && flat.length < 20000; i += 1) {
      var rule = rules[i];
      if (rule.cssRules && rule.cssRules.length) {
        // @media, @supports, @layer and @container all nest.
        var condition = rule.conditionText || (rule.media && rule.media.mediaText) || '';
        var isKeyframes = String(rule.cssText || '').lastIndexOf('@keyframes', 0) === 0;
        if (!isKeyframes) walk(rule.cssRules, condition ? conditions.concat(condition) : conditions);
      } else if (rule.selectorText && rule.style && rule.style.cssText) {
        flat.push({ selector: rule.selectorText, body: rule.style.cssText, conditions: conditions });
      }
    }
  }

  for (var s = 0; s < document.styleSheets.length; s += 1) {
    try { walk(document.styleSheets[s].cssRules, []); } catch (error) { /* cross-origin sheet */ }
  }

  var perSlice = Object.create(null);
  var shell = [];
  var seen = Object.create(null);

  function emit(bucket, rule, key) {
    if (!seen[bucket]) seen[bucket] = Object.create(null);
    if (seen[bucket][key]) return;
    seen[bucket][key] = 1;
    (perSlice[bucket] = perSlice[bucket] || []).push(rule);
  }

  for (var r = 0; r < flat.length; r += 1) {
    var rule = flat[r];
    var key = rule.conditions.join('&') + '|' + rule.selector + '|' + rule.body;

    // A rule that addresses the document belongs to the app layer, wherever it
    // matches: a universal selector matches every node on the page.
    var parts = rule.selector.split(',').map(function (p) { return p.trim(); });
    var documentScoped = parts.every(function (p) {
      var bare = p.replace(DYNAMIC, '').trim();
      // A part that is nothing but a pseudo-element addresses every element's
      // pseudo-element, which is the document's business: a universal selector
      // beside two bare pseudo-elements is a reset, and treating the empty
      // remainder as unrecognised let that rule through to every slice.
      // Backticks are avoided here: this source is itself a template literal.
      if (bare === '') return true;
      return /^(\\*|html|body|:root|:where\\(html\\)|:where\\(body\\))$/.test(bare);
    });
    if (documentScoped) {
      if (!seen.__shell__) seen.__shell__ = Object.create(null);
      if (!seen.__shell__[key]) { seen.__shell__[key] = 1; shell.push(rule); }
      continue;
    }

    var lookup = targetable(rule.selector);
    if (!lookup) continue;

    // Removing a state can leave a selector that no longer parses — inside
    // :not(), for one — and the original still matches whatever it matches
    // today, so it is worth trying before giving up on the rule.
    var matched = query(lookup);
    if (matched === null) matched = query(rule.selector);
    if (matched === null) continue;

    for (var m = 0; m < matched.length; m += 1) {
      // Every enclosing slice, not just the nearest one.
      var node = matched[m];
      while (node && node.nodeType === 1) {
        var marker = node.getAttribute && node.getAttribute(MARKER);
        if (marker) emit(marker, rule, key);
        node = node.parentElement;
      }
    }
  }

  return { slices: perSlice, shell: shell, rulesConsidered: flat.length };
})();
`;

/**
 * The author's own name for each marked slice, where the build still carries it.
 *
 * A production bundle strips React's `_debugSource` and `_debugOwner`, so this
 * returns nothing on a third-party site: measured across four production pages
 * with 3042 live fibers between them, zero names and zero paths came back. A dev
 * server is the opposite — a Vite React app resolves `Card` at
 * `/src/Card.jsx:3`, which is a better name for a folder than anything that can
 * be inferred from markup.
 *
 * Evaluated with `awaitPromise`, after the library has been injected. Absence is
 * the normal case and is reported as such rather than treated as a failure.
 */
export const SOURCE_NAMES = `
(async function () {
  if (typeof ElementSource === 'undefined' || typeof ElementSource.resolveElementInfo !== 'function') {
    return { available: false, named: 0, names: {} };
  }

  var roots = document.querySelectorAll('[data-design-os-slice]');
  var names = {};
  var named = 0;
  var failed = 0;

  for (var i = 0; i < roots.length; i += 1) {
    var root = roots[i];
    try {
      var info = await ElementSource.resolveElementInfo(root);
      if (!info || !info.componentName) continue;
      names[root.getAttribute('data-design-os-slice')] = {
        componentName: info.componentName,
        filePath: info.source ? info.source.filePath : null,
        lineNumber: info.source ? info.source.lineNumber : null,
        stack: (info.stack || []).map(function (frame) { return frame.componentName; }).filter(Boolean).slice(0, 6),
      };
      named += 1;
    } catch (error) {
      failed += 1;
    }
  }

  return { available: true, named: named, failed: failed, total: roots.length, names: names };
})();
`;

/**
 * Waits for the page to stop moving before it is measured.
 *
 * `document.getAnimations` reports CSS animations, CSS transitions and Web
 * Animations together, and each carries a `finished` promise. Awaiting those is
 * what turns "photograph a moving page twice" into two readings of the same
 * pose: stripe.com animates as it loads, and counting how many elements are laid
 * out as grid or flex a moment apart caught a handful of them mid-transition.
 *
 * Two things make this bounded rather than a hang. An animation set to run
 * forever never reaches `finished`, so anything with infinite iterations is left
 * alone — a spinner is not something to wait for. And `finished` rejects when an
 * animation is cancelled, which is ordinary on a page that is still settling, so
 * each is caught on its own rather than failing the batch.
 */
export const SETTLE = `
(function () {
  var CEILING_MS = 6000;

  function rest(ms) { return new Promise(function (done) { setTimeout(done, ms); }); }
  function frame() { return new Promise(function (done) { requestAnimationFrame(function () { done(); }); }); }

  return (async function () {
    if (typeof document.getAnimations !== 'function') return { supported: false, awaited: 0 };

    var running = document.getAnimations();
    var finite = [];
    var endless = 0;

    for (var i = 0; i < running.length; i += 1) {
      var animation = running[i];
      var iterations = Infinity;
      try {
        var timing = animation.effect && animation.effect.getComputedTiming
          ? animation.effect.getComputedTiming()
          : (animation.effect && animation.effect.getTiming ? animation.effect.getTiming() : null);
        iterations = timing ? timing.iterations : Infinity;
      } catch (error) {
        iterations = Infinity;
      }

      if (iterations === Infinity || iterations === null) { endless += 1; continue; }
      if (animation.playState === 'paused' || animation.playState === 'idle') continue;
      finite.push(animation);
    }

    var timedOut = false;
    if (finite.length > 0) {
      var settled = Promise.all(finite.map(function (animation) {
        // A cancelled animation rejects, and that still counts as stopped.
        return animation.finished.catch(function () { return null; });
      }));
      var raced = await Promise.race([settled.then(function () { return 'settled'; }), rest(CEILING_MS).then(function () { return 'timeout'; })]);
      timedOut = raced === 'timeout';
    }

    // Two frames after the last animation ends, so the layout it produced is the
    // layout that gets measured.
    await frame();
    await frame();

    return {
      supported: true,
      awaited: finite.length,
      endless: endless,
      total: running.length,
      timedOut: timedOut,
      stillRunning: document.getAnimations().length,
    };
  })();
})();
`;

/**
 * A fingerprint of whatever colour scheme the page is currently showing.
 *
 * Used to prove a variant is a variant. Emulating `prefers-color-scheme` does
 * nothing on a site that drives theme from its own attribute — lawsofux.com
 * reports `matches: true` for dark and stays resolutely light — so a switch has
 * to be verified by looking at what actually changed rather than assumed from
 * the request having been made.
 */
export const MODE_SIGNATURE = `
(function () {
  var root = document.documentElement;
  var interesting = [];
  for (var i = 0; i < root.attributes.length; i += 1) {
    var attribute = root.attributes[i];
    if (/^(class|data-.*(theme|mode|color|scheme).*)$/i.test(attribute.name)) {
      interesting.push(attribute.name + '=' + attribute.value);
    }
  }

  var rootStyle = getComputedStyle(root);
  var bodyStyle = getComputedStyle(document.body);
  return {
    root: interesting.sort().join(' '),
    colorScheme: rootStyle.colorScheme,
    // The canvas is painted from html when body is transparent, which is the
    // usual arrangement and the case on the site this was written against.
    surface: bodyStyle.backgroundColor === 'rgba(0, 0, 0, 0)' ? rootStyle.backgroundColor : bodyStyle.backgroundColor,
    text: bodyStyle.color,
    prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
  };
})();
`;

/**
 * Asks the page to change colour scheme using its own controls.
 *
 * Tried in order of how much it presumes. A control the page already offers is
 * the site's own code path and leaves whatever it normally persists; setting the
 * attribute a theme is keyed off is a guess about the mechanism, so it is only
 * reached when no control could be found. Nothing here reloads: a reload would
 * discard the walk and the state built up before it.
 *
 * @param {'dark'|'light'} mode
 */
export const activateMode = (mode) => `
(function () {
  var wanted = ${JSON.stringify(mode)};
  var opposite = wanted === 'dark' ? 'light' : 'dark';
  var THEME_WORDS = /dark|light|theme|colou?r ?mode|appearance/i;

  function nameOf(element) {
    return String(element.getAttribute('aria-label') || element.title || element.textContent || '').replace(/\\s+/g, ' ').trim();
  }

  // A switch already in the wanted state must not be flipped out of it.
  var controls = [];
  var candidates = document.querySelectorAll('button, [role="button"], [role="switch"], [role="checkbox"], input[type="checkbox"], a');
  for (var i = 0; i < candidates.length; i += 1) {
    var name = nameOf(candidates[i]);
    if (name && THEME_WORDS.test(name) && name.length < 60) controls.push({ element: candidates[i], name: name });
  }

  if (controls.length > 0) {
    var pick = controls[0];
    for (var c = 0; c < controls.length; c += 1) {
      // Prefer a control that names the mode being asked for.
      if (new RegExp(wanted, 'i').test(controls[c].name)) { pick = controls[c]; break; }
    }
    pick.element.click();
    return { via: 'control', detail: pick.name.slice(0, 48), controls: controls.length };
  }

  // No control: set the attribute a theme is commonly keyed off, and the class.
  var root = document.documentElement;
  var touched = [];
  for (var a = 0; a < root.attributes.length; a += 1) {
    var attribute = root.attributes[a];
    if (/^data-.*(theme|mode|color|scheme)/i.test(attribute.name) && new RegExp(opposite, 'i').test(attribute.value)) {
      root.setAttribute(attribute.name, attribute.value.replace(new RegExp(opposite, 'gi'), wanted));
      touched.push(attribute.name);
    }
  }
  if (root.classList.contains(opposite)) { root.classList.remove(opposite); root.classList.add(wanted); touched.push('class'); }
  else if (wanted === 'dark' && touched.length === 0) { root.classList.add('dark'); touched.push('class'); }

  return { via: touched.length ? 'attribute' : 'nothing', detail: touched.join(' ') || 'no control and no theme attribute', controls: 0 };
})();
`;
