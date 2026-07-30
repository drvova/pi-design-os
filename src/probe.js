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
  wrapMethod(
    window.HTMLCanvasElement && HTMLCanvasElement.prototype, 'getContext', 'canvas.getContext',
    report.apis,
    function (args) { bump(report.contexts, String(args[0])); }
  );

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
  // Style elements this tool materialises into a clone are its own scaffolding.
  // Counting them would make every clone look larger than what it copied.
  total -= document.querySelectorAll('style[data-design-os]').length;
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
  var notes = { inlineSheets: 0, adoptedSheets: 0, rules: 0, unreadable: 0, fields: 0, shadowRoots: 0, closedHosts: 0 };

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
