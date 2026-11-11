#!/usr/bin/env node
/**
 * Dev/preview wrapper: `node tools/serve.mjs dev|preview`.
 *
 * Spawns the Rosezm CLI with the body cap and single-worker env the app
 * needs (25MB media uploads; one shared PGlite instance is not cluster-safe).
 */
import { spawn, spawnSync } from "child_process";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] === "preview" ? "preview" : "dev";

// The Rosezm CLI lives inside the rosezm package, whose exports map hides its
// root. Resolve through an exported subpath and walk back up, so the CLI is
// found whether the rosezm package sits in the project's node_modules or
// was hoisted into the parent's by npm.
const require = createRequire(import.meta.url);
const ROZEZM_CLI = resolve(dirname(require.resolve("rosezm/compiler")), "..", "dist-cli", "rosezm.mjs");

// The plugin/theme tables and theme.css are generated from what is installed,
// never committed: regenerate before dev/preview so a fresh checkout - which
// ships only hello-oboext and the default theme - compiles at all.
const gen = spawnSync(process.execPath, [join(ROOT, "tools", "gen.mjs")], { cwd: ROOT, stdio: "inherit" });
if (gen.status !== 0) process.exit(gen.status ?? 1);

const child = spawn(process.execPath, [ROZEZM_CLI, mode, "oboext"], {
  cwd: ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    rosezm_MAX_BODY: process.env.rosezm_MAX_BODY || String(25 * 1024 * 1024),
    rosezm_WORKERS: process.env.rosezm_WORKERS || "1",
  },
});
child.on("exit", (code) => process.exit(code ?? 0));
