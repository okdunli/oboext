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
 *     themes       -> junction to project (theme source/assets, read only)
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
  mkdirSync,
  cpSync,
  symlinkSync,
} from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = join(tmpdir(), 'oboext-stage');

rmSync(join(ROOT, 'server.js'), { force: true });

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
for (const name of ['node_modules', 'src', 'themes', 'plugins', 'oboext', 'tools', 'dist']) {
  try { rmSync(join(STAGE, name), { force: true }); } catch { /* link missing, fine */ }
}
retry('stage reset', () => rmSync(STAGE, { recursive: true, force: true }));
mkdirSync(STAGE, { recursive: true });

for (const name of ['node_modules', 'src', 'themes', 'plugins']) {
  if (existsSync(join(ROOT, name))) junction(join(ROOT, name), join(STAGE, name));
}
for (const name of ['package.json', 'tsconfig.json']) {
  cpSync(join(ROOT, name), join(STAGE, name));
}
cpSync(join(ROOT, 'oboext'), join(STAGE, 'oboext'), { recursive: true });
cpSync(join(ROOT, 'tools'), join(STAGE, 'tools'), { recursive: true });

let r = run([join(STAGE, 'tools', 'gen.mjs')], STAGE);
if (r.status !== 0) process.exit(r.status ?? 1);

r = run([tsxCli, 'src/cli/index.ts', 'build', 'oboext'], STAGE);
if (r.status !== 0) process.exit(r.status ?? 1);

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

rmSync(join(ROOT, 'server.js'), { force: true });
if (existsSync(join(ROOT, 'server.js'))) {
  console.error('[build] FATAL: root server.js survived the build at', join(ROOT, 'server.js'));
  process.exit(1);
}

console.log('[build] done');
