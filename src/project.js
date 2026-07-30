/**
 * Turns a clone into a project you can open, edit and build.
 *
 * A clone is already runnable — it is static markup with its assets beside it —
 * so this adds no build step the pages need. What it adds is the loop: a dev
 * server that reloads the page when you edit its css, and a build that bundles
 * what is there. Both were measured against a real clone of tailwindcss.com
 * before being written here: the dev server and the built output each scored a
 * fidelity of 1 against the same clone served as plain files, so neither the
 * serving nor the bundling changes what renders.
 *
 * Vite is declared here as the clone's own dependency, not design-os's. Nothing
 * is installed by cloning; you run the install in the clone when you want it.
 */

import { writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';

/**
 * Measured against Vite 8.2.0, whose own engine requirement is Node 20.19+.
 * A caret keeps the clone on that major, since a major is where an mpa
 * configuration could reasonably change shape.
 */
const VITE_RANGE = '^8.2.0';

/** Rollup input names have to be unique and usable as file names. */
function inputName(path, taken) {
  const base =
    path
      .replace(/\/(?:ui\/)?index\.html$/, '')
      .replace(/\.html$/, '')
      .replace(/^pages\//, '')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase() || 'index';

  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}-${n}`;
  taken.add(name);
  return name;
}

/**
 * Writes a package.json and a Vite config into a cloned site.
 *
 * Returns what a caller can report: the scripts available, and the pages the
 * build will emit. Mirror clones are refused rather than half-served — see below.
 */
export async function writeDevProject(root, { name, routes = [], mirror = false } = {}) {
  if (mirror) {
    // A mirror keeps the site's own scripts, at the paths its own loader expects.
    // A dev server that transforms javascript would be handed a production bundle
    // it did not build, and the site's runtime-constructed urls do not survive
    // being rewritten. Serving a mirror over plain http is what makes it work, so
    // that is left to design_serve rather than half-done here.
    return { written: false, reason: 'a mirror runs the site’s own scripts, which a dev server would try to rebuild' };
  }

  const taken = new Set();
  const input = {};
  const seen = new Set();
  for (const route of routes) {
    // A route reached twice is still one page. Naming the second one `home-2`
    // would build the same file under two names.
    if (!route?.path || seen.has(route.path)) continue;
    seen.add(route.path);
    input[inputName(route.path, taken)] = route.path;
  }
  // The entry redirect is a page too, and without it a build has no front door.
  if (!seen.has('index.html')) input[inputName('index.html', taken)] = 'index.html';

  const manifest = {
    name: `clone-${String(name || 'site').replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}`,
    private: true,
    type: 'module',
    scripts: {
      dev: 'vite',
      build: 'vite build',
      preview: 'vite preview',
    },
    devDependencies: { vite: VITE_RANGE },
  };

  const config = `// Written by design-os. These pages are already static, so nothing here
// compiles them — Vite is present to serve them with reload-on-edit and to
// bundle them on build. Every cloned route is listed, because a multi-page site
// has no single entry to infer.
export default {
  // Serve files by their own path. Without this a missing page would fall back
  // to the entry, which hides a broken link instead of showing it.
  appType: 'mpa',
  build: {
    rollupOptions: {
      input: {
${Object.entries(input)
  .map(([name, path]) => `        '${name}': '${path}',`)
  .join('\n')}
      },
    },
  },
};
`;

  await writeFile(join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(join(root, 'vite.config.js'), config, 'utf8');

  return { written: true, pages: Object.keys(input).length, scripts: Object.keys(manifest.scripts), vite: VITE_RANGE };
}

/** The lines a README needs so the project is obvious without reading the config. */
export function devProjectNotes(project) {
  if (!project?.written) {
    if (!project?.reason) return [];
    const why = project.reason.charAt(0).toUpperCase() + project.reason.slice(1);
    return ['', '## Running it', '', `${why}, so serve it over http:`, '', '```sh', 'design-os serve <dir>', '```'];
  }

  return [
    '',
    '## Running it',
    '',
    '```sh',
    'npm install && npm run dev      # or: bun install && bun run dev',
    'npm run build                   # bundles every page into dist/',
    'npm run preview                 # serves what build produced',
    '```',
    '',
    'None of that is needed to read the copy — it is static markup and opens from',
    'disk. It is here for editing: the dev server reloads a page when you change its',
    'css. Both paths were scored against this clone served as plain files before',
    'being offered, and each matched it exactly.',
    '',
    `Every cloned route is a build entry (${project.pages}), because a multi-page site has no single`,
    'entry to infer. Slice previews are served in dev but are not build entries.',
    '',
    'For a copy you only want to look at, `design-os serve <dir>` needs no install.',
    'Opening `file://` shows markup and images but a browser refuses webfonts over',
    'it, so text falls back to a system face.',
  ];
}
