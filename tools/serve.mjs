#!/usr/bin/env node
/**
 * Dev/preview wrapper: `node tools/serve.mjs dev|preview`.
 *
 * Spawns the rosezm CLI with the body cap and single-worker env the app
 * needs (25MB media uploads; one shared PGlite instance is not cluster-safe).
 */
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] === "preview" ? "preview" : "dev";

const binField = JSON.parse(readFileSync(join(ROOT, "node_modules/tsx/package.json"), "utf8")).bin;
const tsxCli = join(ROOT, "node_modules/tsx", typeof binField === "string" ? binField : binField.tsx);

const child = spawn(process.execPath, [tsxCli, "src/cli/index.ts", mode, "oboext"], {
  cwd: ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    rosezm_MAX_BODY: process.env.rosezm_MAX_BODY || String(25 * 1024 * 1024),
    rosezm_WORKERS: process.env.rosezm_WORKERS || "1",
  },
});
child.on("exit", (code) => process.exit(code ?? 0));
