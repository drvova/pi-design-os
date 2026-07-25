/**
 * The component set every direction renders.
 *
 * This is the single source for both the gallery preview and the copy-out
 * payload: the gallery renders this markup, and copying reads the rendered
 * node back. There is no second copy of the markup to drift.
 *
 * Markup is semantic HTML with class hooks only. All visual decisions live in
 * custom properties, which is what lets one stylesheet serve every direction.
 */

export const COMPONENT_CSS = `
.ds-root {
  background: var(--ds-canvas);
  color: var(--ds-text);
  font-family: var(--ds-font-sans);
  font-size: var(--ds-text-base);
  font-weight: var(--ds-weight-regular);
  line-height: var(--ds-leading);
}
.ds-stack { display: grid; gap: var(--ds-space-3); }
.ds-row { display: flex; flex-wrap: wrap; gap: var(--ds-space-2); align-items: center; }

.ds-button {
  font: inherit;
  font-weight: var(--ds-weight-bold);
  padding: var(--ds-space-2) var(--ds-space-3);
  border: 1px solid transparent;
  border-radius: var(--ds-radius-md);
  background: var(--ds-accent);
  color: var(--ds-accent-text);
  cursor: pointer;
  transition: background var(--ds-duration) var(--ds-ease),
    transform var(--ds-duration) var(--ds-ease);
}
.ds-button:hover { background: var(--ds-accent-hover); transform: translateY(var(--ds-lift)); }
.ds-button:focus-visible { outline: 2px solid var(--ds-accent); outline-offset: 2px; }
.ds-button--secondary {
  background: var(--ds-accent-subtle);
  color: var(--ds-accent);
  border-color: var(--ds-border);
}
.ds-button--secondary:hover { background: var(--ds-accent-subtle); }
.ds-button--ghost { background: transparent; color: var(--ds-accent); }
.ds-button--ghost:hover { background: var(--ds-accent-subtle); }

.ds-field { display: grid; gap: var(--ds-space-1); }
.ds-label { font-size: var(--ds-text-sm); color: var(--ds-muted); }
.ds-input {
  font: inherit;
  padding: var(--ds-space-2) var(--ds-space-3);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-sm);
  background: var(--ds-surface);
  color: var(--ds-text);
  transition: border-color var(--ds-duration) var(--ds-ease);
}
.ds-input:focus { outline: none; border-color: var(--ds-accent); }
.ds-input::placeholder { color: var(--ds-muted); }

.ds-card {
  display: grid;
  gap: var(--ds-space-2);
  padding: var(--ds-space-4);
  background: var(--ds-surface);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-lg);
  box-shadow: var(--ds-shadow);
}
.ds-card__title {
  margin: 0;
  font-size: var(--ds-text-xl);
  font-weight: var(--ds-weight-bold);
  line-height: 1.2;
}
.ds-card__body { margin: 0; color: var(--ds-muted); font-size: var(--ds-text-sm); }

.ds-badge {
  display: inline-block;
  padding: var(--ds-space-1) var(--ds-space-2);
  font-size: var(--ds-text-sm);
  font-weight: var(--ds-weight-bold);
  border-radius: var(--ds-radius-pill);
  background: var(--ds-accent-subtle);
  color: var(--ds-accent);
}

.ds-switch { display: inline-flex; align-items: center; gap: var(--ds-space-2); cursor: pointer; }
.ds-switch__track {
  position: relative;
  width: 2.5rem;
  height: 1.375rem;
  border-radius: var(--ds-radius-pill);
  background: var(--ds-border);
  transition: background var(--ds-duration) var(--ds-ease);
}
.ds-switch__track::after {
  content: '';
  position: absolute;
  inset-block-start: 0.1875rem;
  inset-inline-start: 0.1875rem;
  width: 1rem;
  height: 1rem;
  border-radius: var(--ds-radius-pill);
  background: var(--ds-surface);
  transition: translate var(--ds-duration) var(--ds-ease);
}
.ds-switch input { position: absolute; opacity: 0; pointer-events: none; }
.ds-switch input:checked + .ds-switch__track { background: var(--ds-accent); }
.ds-switch input:checked + .ds-switch__track::after { translate: 1.125rem 0; }
.ds-switch input:focus-visible + .ds-switch__track { outline: 2px solid var(--ds-accent); outline-offset: 2px; }

.ds-alert {
  display: grid;
  gap: var(--ds-space-1);
  padding: var(--ds-space-3);
  border-radius: var(--ds-radius-md);
  border-inline-start: 3px solid var(--ds-accent);
  background: var(--ds-accent-subtle);
}
.ds-alert__title { font-weight: var(--ds-weight-bold); }
.ds-alert__body { font-size: var(--ds-text-sm); color: var(--ds-muted); }
`.trim();

/** Every component the gallery renders, in display order. */
export const COMPONENTS = [
  {
    name: 'button',
    html: `<div class="ds-row">
  <button class="ds-button" type="button">Continue</button>
  <button class="ds-button ds-button--secondary" type="button">Cancel</button>
  <button class="ds-button ds-button--ghost" type="button">Learn more</button>
</div>`,
  },
  {
    name: 'field',
    html: `<div class="ds-field">
  <label class="ds-label" for="email">Email address</label>
  <input class="ds-input" id="email" type="email" placeholder="you@example.com" />
</div>`,
  },
  {
    name: 'card',
    html: `<article class="ds-card">
  <span class="ds-badge">New</span>
  <h3 class="ds-card__title">Deployment ready</h3>
  <p class="ds-card__body">Every check passed. Ship whenever you are ready.</p>
  <div class="ds-row">
    <button class="ds-button" type="button">Deploy</button>
  </div>
</article>`,
  },
  {
    name: 'switch',
    html: `<label class="ds-switch">
  <input type="checkbox" checked />
  <span class="ds-switch__track"></span>
  <span>Automatic updates</span>
</label>`,
  },
  {
    name: 'alert',
    html: `<div class="ds-alert" role="status">
  <span class="ds-alert__title">Build complete</span>
  <span class="ds-alert__body">Finished in 12.4s with no warnings.</span>
</div>`,
  },
];
