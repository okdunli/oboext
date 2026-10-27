#!/usr/bin/env node
// Native export wrapper for Oboext.
//
// The vendored rosezm ships a 14-target exporter (WeChat/QQ/Alipay/
// Baidu/Douyin mini programs, Flutter, Android, HarmonyOS, Xcode, Electron,
// Python/.NET/Java/C++ desktop). This tool points it at the Oboext app source
// and records which server the exported client should call:
//
//   node --import tsx tools/export-native.mts <target> [--api-base URL] [--out DIR]
//
// The exporter reads the .rose sources under oboext/; run `node tools/build.mjs
// build` first so routes.ts is current. Output lands in oboext/.rosezm-export
// (gitignored) unless --out says otherwise.
import { exportProject, targetList, TARGETS, type TargetName } from "../src/export/index.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = path.join(ROOT, "oboext");

const argv = process.argv.slice(2);
const flags: Record<string, string> = {};
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--api-base" || a === "--out") flags[a.slice(2)] = argv[++i] ?? "";
  else if (a === "--help" || a === "-h") flags.help = "1";
  else positional.push(a);
}

if (flags.help || positional.length === 0) {
  console.log("usage: node --import tsx tools/export-native.mts <target> [--api-base URL] [--out DIR]");
  console.log("targets:\n" + targetList());
  process.exit(flags.help ? 0 : 2);
}

const target = positional[0];
if (!(target in TARGETS)) {
  console.error(`unknown target "${target}"\n${targetList()}`);
  process.exit(2);
}

const apiBase = flags["api-base"] ?? process.env.OBOEXT_API_BASE ?? "";
if (!apiBase) {
  console.warn("[export] no --api-base: the exported client will call relative paths (same-origin only). Pass --api-base https://your-site for a standalone client.");
}

const result = await exportProject(target as TargetName, PROJECT, {
  apiBase,
  outRoot: flags.out ? path.resolve(flags.out) : undefined,
});

console.log(`[export] ${target} -> ${path.relative(ROOT, result.outDir)}`);
console.log(`[export] pages: ${result.pages.length}, components: ${result.components.length}`);
for (const w of result.warnings) console.warn(`[export] warning: ${w}`);
if (result.warnings.length) {
  console.warn(`[export] ${result.warnings.length} unsupported construct(s) were emitted as warnings, not silence`);
}
