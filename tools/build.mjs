#!/usr/bin/env node
/**
 * Staging build wrapper for Windows vault folders.
 *
 * This project lives inside a cloud-synced folder (Nutstore indexes new
 * files). rosezm emits many intermediate modules into dist/.build and
 * removes them immediately; the sync watcher still holds handles on those
 * fresh .js files, so the delete fails with EBUSY every time. The framework
 * stays pristine - we stage the build in a directory the watcher does not
 * monitor:
 *
 *   stage/
 *     node_modules -> junction to project (deps are only read)
 *     src          -> junction to project (framework + server code)
 *     seed         -> junction to project (theme source/assets, read only)
 *     oboext/     real copy (gen writes public resources; compiler writes dist)
 *     tools/       real copy (import.meta-based ROOT must resolve in stage)
 *     *.json       real copy
 *
 * gen -> rosezm build both run inside the stage; the finished
 * dist/ is mirrored back into the vault. Pages are authored (not generated),
 * so nothing under oboext/src needs mirroring back.
 *
 * Usage: node tools/build.mjs [build]
 */
import { spawnSync } from 'child_process';
import {
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  cpSync,
  symlinkSync,
  readdirSync,
} from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = join(tmpdir(), 'oboext-stage');

// NOTE: the deployment entrypoint is the root index.js, which loads
// dist/prod.mjs and dispatches each request into the http.Server it exports.
// Do NOT delete it here. The Vercel lambda always names its handler server.js,
// and dist/server.js can shadow that key - the end of this build appends a
// function default export to dist/server.js so either file satisfies the
// launcher's "default export must be a function or server" contract.

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function retry(label, fn, tries = 20) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return fn();
    } catch (e) {
      last = e;
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY', 'ENOENT'].includes(e.code)) throw e;
      sleep(250 * (i + 1));
    }
  }
  throw new Error(label + ' failed after retries: ' + last.message);
}

/** File count under dir, for the deploy-root mirror report. */
function countFiles(dir) {
  let n = 0;
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.isFile()) n++;
    }
  })(dir);
  return n;
}

// Native directory junction: no shell, no elevation on Windows.
function junction(target, link) {
  symlinkSync(target, link, 'junction');
}

function run(args, cwd) {
  const r = spawnSync(process.execPath, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] });
  return r;
}

const binField = JSON.parse(readFileSync(join(ROOT, 'node_modules/tsx/package.json'), 'utf8')).bin;
const tsxCli = join(ROOT, 'node_modules/tsx', typeof binField === 'string' ? binField : binField.tsx);

console.log('[build] staging in', STAGE);
// The junctions below link into the REAL project. rimraf semantics for a
// junction differ across Node versions and one run followed the link and
// emptied src/ in the vault, so each junction is unlinked FIRST - rmSync
// with force on a symlink/junction removes the link itself, never the
// target - and only then is the stage root removed.
for (const name of ['node_modules', 'src', 'themes', 'plugins', 'oboext', 'tools', 'dist', 'seed']) {
  try { rmSync(join(STAGE, name), { force: true }); } catch { /* link missing, fine */ }
}
retry('stage reset', () => rmSync(STAGE, { recursive: true, force: true }));
mkdirSync(STAGE, { recursive: true });

// `themes` is required in the stage: tools/gen.mjs now reads the site-wide
// chrome stylesheet and fonts from themes/<slug>/ so a theme stays
// self-contained. `seed` is intentionally NOT linked - it holds only the demo
// fixture (seed-source.json) and nothing on the asset or build path reads it,
// so an absent seed/ cannot fail the build.
for (const name of ['node_modules', 'src', 'themes', 'plugins']) {
  if (existsSync(join(ROOT, name))) junction(join(ROOT, name), join(STAGE, name));
}
for (const name of ['package.json', 'tsconfig.json']) {
  cpSync(join(ROOT, name), join(STAGE, name));
}
cpSync(join(ROOT, 'oboext'), join(STAGE, 'oboext'), { recursive: true });
cpSync(join(ROOT, 'tools'), join(STAGE, 'tools'), { recursive: true });

// 1) static, content-free resources only: theme.css, avatars, noflash.js
let r = run([join(STAGE, 'tools', 'gen.mjs')], STAGE);
if (r.status !== 0) process.exit(r.status ?? 1);

// 2) rosezm production build (in stage: no cloud watcher, no EBUSY)
r = run([tsxCli, 'src/cli/index.ts', 'build', 'oboext'], STAGE);
if (r.status !== 0) process.exit(r.status ?? 1);

// 3) mirror finished artifacts back into the vault project
console.log('[build] mirroring artifacts back');
retry('dist mirror', () => {
  rmSync(join(ROOT, 'dist'), { recursive: true, force: true });
  cpSync(join(STAGE, 'dist'), join(ROOT, 'dist'), { recursive: true });
});
retry('theme mirror', () =>
  cpSync(join(STAGE, 'oboext', 'theme.css'), join(ROOT, 'oboext', 'theme.css')),
);

retry('entries mirror', () =>
  cpSync(
    join(STAGE, 'oboext', 'src', 'server', 'plugin-entries.ts'),
    join(ROOT, 'oboext', 'src', 'server', 'plugin-entries.ts'),
  ),
);
retry('public mirror', () =>
  cpSync(join(STAGE, 'oboext', 'public'), join(ROOT, 'oboext', 'public'), { recursive: true }),
);

// ---------------------------------------------------------------------------
// Vercel deploy-root mirror.
//
// Vercel's zero-config builder injects one static build whose glob is a HARD
// CONSTANT - `src: "public/**/*", outputDirectory: "public"`
// (@vercel/static-build dist/index.js) - and `vercel.json` cannot change it.
// With no `public/` at the deploy root the glob matches zero files, no
// .vercel/output/static/ directory is produced, and every asset the app links
// as /public/** has to be served by the lambda instead. That costs a function
// invocation (and therefore a cold start, and a Neon connection) per icon -
// there are ~1300 SVGs under oboext/public/icons alone - and the generated
// config.json falls back to a catch-all 404 route for non-/api paths.
//
// The app's assets live in oboext/public because that is where the rosezm
// compiler and tools/gen.mjs write them, and the URLs are /public/** (121
// references across the server code and themes, plus filesystem reads like
// oboext/public/icons). Moving the directory would churn all of them; instead
// mirror the finished tree to the deploy root. Same URLs, same filesystem
// paths, and Vercel gets a real static/ to serve from.
//
// Generated, not tracked: public/ is in .gitignore.
const rootPublic = join(ROOT, 'public');
retry('deploy-root public', () => {
  rmSync(rootPublic, { recursive: true, force: true });
  cpSync(join(STAGE, 'oboext', 'public'), rootPublic, { recursive: true });
});
console.log(`[build] deploy-root public/ -> ${countFiles(rootPublic)} files (Vercel static glob)`);

// The Vercel lambda always names its handler `server.js`, and the bundle keys
// files by basename, so `dist/server.js` (the rosezm application module: 39
// named exports, no default) collides with - and wins over - the real entry.
// The launcher then imports a module whose default export is neither a function
// nor a server, and every request fails at cold start with
//   Invalid export found in module "/var/task/server.js".
// dist/prod.mjs is the self-contained HTTP server (the lambda entry index.js
// loads it and dispatches into it), so giving dist/server.js a function default
// export makes whichever file wins the key collision satisfy the contract.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// R58: the framework tree (oboext/oboext/src) now carries the fixes these two
// build-time patches used to inject - rosezm BUG.md W (generation guard +
// finish-hook invalidation, R56) and BUG.md Y (set-cookie as a list header,
// R57) are upstream, and the prod-server exposes the app-level commit-point
// hook as globalThis.__rosezmInvalidateHot. Both patches are REMOVED: their
// anchors no longer exist in the bundle, and the framework implementation
// supersedes them (src/server/cache.ts calls the framework hook directly).
// ---------------------------------------------------------------------------
const distServer = join(ROOT, 'dist', 'server.js');
if (existsSync(distServer)) {
  const src = readFileSync(distServer, 'utf8');
  if (!/\bexport\s+default\b/.test(src)) {
    const banner = [
      '',
      '// --- Vercel lambda entry shim (appended by tools/build.mjs) ---',
      '// The Vercel lambda names its handler server.js and keys bundle files by',
      '// basename, so this file can shadow the intended entry. Exporting a',
      '// request function keeps the launcher contract satisfied regardless of',
      '// which file wins: it must be a function or a server.',
      "import __oboextProd from './prod.mjs';",
      'const __oboextServer = __oboextProd && __oboextProd.default ? __oboextProd.default : __oboextProd;',
      'export default function oboextVercelHandler(req, res) {',
      "  if (!__oboextServer || typeof __oboextServer.emit !== 'function') {",
      '    res.statusCode = 500;',
      "    res.setHeader('content-type', 'text/plain; charset=utf-8');",
      "    res.end('oboext server bundle failed to load');",
      '    return;',
      '  }',
      "  __oboextServer.emit('request', req, res);",
      '}',
      '',
    ].join('\n');
    retry('dist/server.js shim', () => {
      writeFileSync(distServer, src + banner);
      rmSync(distServer + '.br', { force: true });
      rmSync(distServer + '.gz', { force: true });
    });
    console.log('[build] appended Vercel handler shim to dist/server.js');
  }
}

console.log('[build] done');
