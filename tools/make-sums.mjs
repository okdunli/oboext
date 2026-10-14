#!/usr/bin/env node
/**
 * SHA256SUMS generator for release snapshots.
 *
 * Every oboext-<version> folder ships a SHA256SUMS listing every file it
 * contains (uppercase hex, two spaces, forward-slash relative path — the
 * sha256sum(1) layout), excluding SHA256SUMS itself. Run it against a
 * snapshot after copying the project:
 *
 *   node tools/make-sums.mjs ../oboext-0.4.0
 *   node tools/make-sums.mjs              # defaults to this project root
 *
 * Symlinks are skipped (none are expected in a snapshot).
 */
import { createHash } from "crypto";
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join, relative, sep, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = "SHA256SUMS";

const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.isFile()) files.push(p);
  }
})(ROOT);

const rows = files
  .map((p) => ({ p, rel: relative(ROOT, p).split(sep).join("/") }))
  .filter((r) => r.rel !== OUT)
  .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  .map((r) => `${createHash("sha256").update(readFileSync(r.p)).digest("hex").toUpperCase()}  ${r.rel}`);

writeFileSync(join(ROOT, OUT), rows.join("\n") + "\n", "utf8");
console.log(`[sums] ${rows.length} entries -> ${join(ROOT, OUT)} (walked ${files.length} files)`);