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
// rosezm BUG.md entry W: prod-server clears hotCache at the TOP of every
// non-GET handler while background warm renders may be in flight; a warm that
// finishes after the clear stores pre-mutation bytes and serves them for a
// full TTL. Measured on oboext: 8/8 admin publishes followed by a cookieless
// read served stale content (scripts/warm-race.test.mts is the regression
// lock). rosezm is read-only here, so the fix is applied to OUR build artifact
// with anchored edits: every anchor must occur exactly once, the result must
// pass `node --check`, and a banner marks the patched region. Anchor drift
// fails the build loudly instead of silently shipping the racy server.
const WARM_RACE_BANNER = 'oboext patch: warm/invalidation generation guard';
const WARM_RACE_DECL = "// --- oboext patch: warm/invalidation generation guard (rosezm BUG.md W) ---\n// Every invalidation bumps hotGen; a store whose captured generation is\n// stale served pre-invalidation bytes (the warm-race bug).\nvar hotGen=0;\nglobalThis.__oboextHotInvalidate=function(){hotGen++,te.clear();let f=ye.invalidateRenderCache;typeof f==\"function\"&&f()};\nvar te=new Map,bn=300;";
function patchWarmRace(file) {
  if (!existsSync(file)) return;
  // Escape hatch for A/B evidence runs: OBOEXT_SKIP_WARM_PATCH=1 ships the
  // unpatched server so the race can be re-measured against the current
  // framework (scripts/warm-race.test.mts fails loudly without the patch).
  if (process.env.OBOEXT_SKIP_WARM_PATCH === '1') {
    console.log('[build] warm-race patch SKIPPED (OBOEXT_SKIP_WARM_PATCH=1)');
    return;
  }
  let src = readFileSync(file, 'utf8');
  if (src.includes(WARM_RACE_BANNER)) {
    console.log('[build] warm-race patch already present in dist/prod.mjs');
    return;
  }
  const edit = (from, to, label) => {
    const n = src.split(from).length - 1;
    if (n !== 1) {
      throw new Error(
        `warm-race patch anchor '${label}' matched ${n} times (expected 1) - rosezm drifted, re-author the patch`,
      );
    }
    src = src.replace(from, to);
  };

  // 0.1.8 ships a MINIFIED prod-server bundle: hotCache -> te, HOT_TTL -> Sn,
  // refetchHot -> Vr, fillHot -> mn, ready -> yn, mod -> ye, req/res -> e/t.
  // The anchors below are structural (whole statements), not names, so they
  // survive identifier mangling; the uniqueness assertion is the drift guard.

  // 1) generation counter + the app-level commit-point hook, next to the cache
  edit(
    'var te=new Map,bn=300;',
    WARM_RACE_DECL,
    'hotCache declaration',
  );

  // 2) invalidate on response finish - AFTER the mutation commits - not before
  edit(
    'if(e.method!=="GET"&&e.method!=="HEAD"){te.clear();let u=ye.invalidateRenderCache;typeof u=="function"&&u()}',
    'if(e.method!=="GET"&&e.method!=="HEAD"){let iv=!1;const inv=()=>{if(iv)return;iv=!0,hotGen++,te.clear();let u=ye.invalidateRenderCache;typeof u=="function"&&u()};typeof t.on=="function"?(t.on("finish",inv),t.on("close",inv)):inv()}',
    'non-GET invalidation block',
  );

  // 3) capture this request generation for its own store
  edit('if(await yn,Kr(e,t))return;', 'if(await yn,Kr(e,t))return;const rqG=hotGen;', 'handler top');

  // 4) warm renders: capture at entry, refuse to store across an invalidation
  edit('async function Vr(e,t){', 'async function Vr(e,t){const wG=hotGen;', 'refetchHot head');
  edit(
    '))),o=r.headers.get("content-security-policy")',
    ')));if(wG!==hotGen)return;let o=r.headers.get("content-security-policy")',
    'refetchHot store guard',
  );

  // 5) request-path store: same guard (arrayBuffer + compression open a window)
  edit(
    'function mn(e,t,n,r,o){',
    'function mn(e,t,n,r,o,g){if(g!==void 0&&g!==hotGen)return;',
    'fillHot head',
  );
  edit(
    'e.method==="GET"&&mn(De(e.url||"/"),o,a,g,u)',
    'e.method==="GET"&&mn(De(e.url||"/"),o,a,g,u,rqG)',
    'fillHot call A',
  );
  edit(
    '`W/"${h.length}-${ve(o)}"`)',
    '`W/"${h.length}-${ve(o)}"`,rqG)',
    'fillHot call B',
  );

  writeFileSync(file, src);
  const check = spawnSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  if (check.status !== 0) {
    throw new Error('patched dist/prod.mjs failed node --check: ' + String(check.stderr));
  }
  console.log('[build] warm-race patch applied to dist/prod.mjs (BUG.md W)');
}

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

patchWarmRace(join(ROOT, 'dist', 'prod.mjs'));

// ---------------------------------------------------------------------------
// rosezm BUG.md entry Y: the prod-server writes response headers with
// `headers.forEach((v, k) => res.setHeader(k, v))`. For set-cookie that is
// lossy twice over: on runtimes whose forEach combines multi-value cookies
// into one comma-joined callback the browser sees a single malformed
// Set-Cookie; on runtimes whose forEach fires once per cookie the second
// setHeader REPLACES the first (node semantics), so only the last cookie
// survives. Either way a login response lost its cms_session cookie and
// every admin write then failed CSRF (no-token) - a total admin lockout.
// The framework is read-only; patch the bundle to emit one header per
// cookie, which is what the spec requires.
// ---------------------------------------------------------------------------
function patchSetCookieHeaders(file) {
  if (!existsSync(file)) return;
  let src = readFileSync(file, 'utf8');
  const anchor = 'a.headers.forEach((u,g)=>t.setHeader(g,u))';
  if (!src.includes(anchor)) {
    if (src.includes('__oboextSetCookie')) return;
    throw new Error(
      'BUG.md Y: set-cookie export anchor not found in dist/prod.mjs ' +
        '- the framework bundle changed shape; re-derive the patch before shipping.',
    );
  }
  // The anchor sits inside a comma expression (forEach(...), kn(t, ...)),
  // so the extra step must stay an expression too - an IIFE, not a block.
  const replacement =
    'a.headers.forEach((u,g)=>{if(g==="set-cookie")return;t.setHeader(g,u)}),' +
    '(()=>{const __oboextSetCookie=a.headers.getSetCookie?a.headers.getSetCookie():[];' +
    'if(__oboextSetCookie.length)t.setHeader("set-cookie",__oboextSetCookie)})()';
  src = src.replace(anchor, replacement);
  retry('dist/prod.mjs set-cookie patch', () => writeFileSync(file, src));
  const check = spawnSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  if (check.status !== 0) {
    throw new Error('patched dist/prod.mjs failed node --check: ' + String(check.stderr));
  }
  console.log('[build] set-cookie header patch applied to dist/prod.mjs (BUG.md Y)');
}

patchSetCookieHeaders(join(ROOT, 'dist', 'prod.mjs'));

console.log('[build] done');
