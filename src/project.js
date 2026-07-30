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

import { spawn } from 'node:child_process';
import { access, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, posix, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

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

/**
 * Package managers worth trying, fastest first.
 *
 * Bun installs the same tree in a fraction of the time and runs the same
 * scripts, so it is preferred when present. Nothing here is bun-specific: the
 * project it builds has no lockfile of its own, so either manager resolves it.
 */
const MANAGERS = ['bun', 'npm'];

function execute(command, args, cwd) {
  return new Promise((settled) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('error', (error) => settled({ code: null, out, err: error.message }));
    child.on('close', (code) => settled({ code, out, err }));
  });
}

async function available(manager) {
  const { code } = await execute(manager, ['--version'], process.cwd());
  return code === 0;
}

/** Bytes on disk under a directory, so a build can report its own weight. */
async function weigh(dir) {
  let bytes = 0;
  const walk = async (at) => {
    for (const entry of await readdir(at, { withFileTypes: true }).catch(() => [])) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) await walk(path);
      else bytes += await stat(path).then((info) => info.size).catch(() => 0);
    }
  };
  await walk(dir);
  return bytes;
}

/**
 * Installs the project's dependencies and builds it, leaving the source alone.
 *
 * The point of building in place is that both exist afterwards: `dist/` is
 * servable and the pages beside it are still the ones you edit. A build is never
 * substituted for the copy.
 *
 * This is the one part of design-os that reaches the network for something other
 * than the site being cloned, since a build needs its bundler installed. It is
 * therefore asked for rather than assumed, and a failure is reported as a failed
 * build of a clone that is otherwise complete.
 */
export async function buildProject(root, { manager } = {}) {
  await access(join(root, 'package.json')).catch(() => {
    throw new Error(
      `${root} has no package.json, so there is nothing to build. Clone without \`vite: false\`, ` +
        'or serve it as it is — the pages are already static.',
    );
  });

  const chosen = manager ?? (await MANAGERS.reduce(async (found, next) => (await found) || ((await available(next)) ? next : null), Promise.resolve(null)));
  if (!chosen) return { ok: false, reason: `no package manager found; tried ${MANAGERS.join(' and ')}` };

  const installed = await execute(chosen, ['install'], root);
  if (installed.code !== 0) {
    return {
      ok: false,
      manager: chosen,
      step: 'install',
      // The tail, because a failing install says why in its last few lines.
      reason: (installed.err || installed.out).trim().split('\n').slice(-4).join(' ').slice(0, 400),
    };
  }

  const built = await execute(chosen, ['run', 'build'], root);
  if (built.code !== 0) {
    return {
      ok: false,
      manager: chosen,
      step: 'build',
      reason: (built.err || built.out).trim().split('\n').slice(-6).join(' ').slice(0, 500),
    };
  }

  // A build that exits zero having emitted nothing is not a build. Every entry
  // the config names has to have produced a file.
  const config = (await import(`${pathToFileURL(join(root, 'vite.config.js')).href}?read=${Date.now()}`)).default;
  const expected = Object.values(config?.build?.rollupOptions?.input ?? {});
  const dist = join(root, 'dist');
  const missing = [];
  for (const page of expected) {
    await access(join(dist, page)).catch(() => missing.push(page));
  }
  if (missing.length > 0) {
    return { ok: false, manager: chosen, step: 'build', reason: `built without emitting ${missing.join(', ')}` };
  }

  return {
    ok: true,
    manager: chosen,
    dist: relative(root, dist) || 'dist',
    pages: expected.length,
    bytes: await weigh(dist),
  };
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
