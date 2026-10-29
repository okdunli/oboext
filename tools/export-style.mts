#!/usr/bin/env node
/**
 * Export post-processing: carry the site's skin into the generated tree.
 *
 * The Rosezm exporter only translates the `.rose` `<style>` blocks plus
 * SHELL_STYLES, so an exported client is structurally right but visually
 * bare (BUG.md CF). Two passes, one per output family:
 *
 *   mini-program  -> append the site stylesheet to app.<wxss|qss|acss|css|ttss>
 *   flutter       -> emit lib/site_theme.dart and point main.dart's ThemeData at it
 *
 *   node --import tsx tools/export-style.mts <outDir> <target>
 */
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Mini-program style dialects, mirroring the framework's DIALECTS table. */
const MINI_STYLE: Record<string, string> = {
  weapp: "wxss",
  qq: "qss",
  alipay: "acss",
  baidu: "css",
  toutiao: "ttss",
};

/** Selectors no mini program engine understands; a rule carrying one is
 *  dropped whole — a dead selector is harmless, an unsupported one can be
 *  rejected at upload time. */
const DROP_SELECTOR = /:has\(|::part\(|::v-deep|@supports|:is\(|:where\(/i;

/** @-rules that carry no meaning on a mini program (printer, scrollbars). */
const DROP_AT_RULE = /^@(supports|page|font-face)\b|@media\s+(print|speech)/i;

export type StyleApplyResult = {
  target: string;
  file: string;
  bytes: number;
  dropped: string[];
};

/** The site's skin: theme.css (fonts inlined) or the default theme's own CSS. */
export function siteStylesheet(): { css: string; source: string } {
  const generated = path.join(ROOT, "oboext", "theme.css");
  if (existsSync(generated)) {
    return { css: readFileSync(generated, "utf8"), source: "oboext/theme.css" };
  }
  const themes = path.join(ROOT, "themes");
  for (const slug of existsSync(themes) ? readdirSync(themes) : []) {
    const cssPath = path.join(themes, slug, `${slug}.css`);
    if (existsSync(cssPath)) {
      return { css: readFileSync(cssPath, "utf8"), source: `themes/${slug}/${slug}.css` };
    }
  }
  return { css: "", source: "" };
}

/** Split a stylesheet into top-level blocks so @-rules stay intact. */
function blocks(css: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = "";
  for (const ch of css) {
    buf += ch;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth <= 0) {
        out.push(buf.trim());
        buf = "";
        depth = 0;
      }
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/** Strip a leading /* section *\/ comment so an @-rule is seen as the head. */
function headOf(block: string): string {
  return block
    .split("{")[0]!
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim();
}

export function sanitizeForMiniProgram(css: string): { css: string; dropped: string[] } {
  const dropped: string[] = [];
  const kept: string[] = [];
  for (const b of blocks(css)) {
    const head = headOf(b);
    if (DROP_AT_RULE.test(head)) {
      // @font-face with an inlined data URI is 30-90 KB a mini program cannot
      // render anyway; @supports/print are dead weight.
      dropped.push(head.slice(0, 60));
      continue;
    }
    if (DROP_SELECTOR.test(head)) {
      dropped.push(head.slice(0, 60));
      continue;
    }
    kept.push(b);
  }
  return { css: kept.join("\n\n"), dropped };
}

/** The whole `theme: ThemeData(...)` argument, closing paren included.
 *  A `[^)]*` slice stops at the first inner `)` — `Color(0xFFE91E63)` — and
 *  leaves the outer one behind, so the patched file grows a stray paren. */
function matchThemeData(src: string): string | null {
  const at = src.indexOf("ThemeData(");
  if (at < 0) return null;
  let depth = 0;
  for (let i = at + "ThemeData".length; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return src.slice(src.lastIndexOf("theme:", at), i + 1);
    }
  }
  return null;
}

/** Custom-property names declared in the site's `:root` — the marker we use
 *  to detect that a stylesheet ALREADY carries the site skin. */
export function rootTokenNames(css: string): string[] {
  const names: string[] = [];
  for (const m of css.matchAll(/:root\s*\{([\s\S]*?)\}/g)) {
    for (const d of m[1]!.matchAll(/(--[\w-]+)\s*:/g)) names.push(d[1]!);
  }
  return names;
}

// ─────────────────────────────────────────────────────────── flutter / dart ──

/** The palette slot -> the token names a theme may spell it with, in order. */
const PALETTE_SLOTS: Array<[slot: string, tokens: string[]]> = [
  ["primary", ["--primary", "--accent", "--brand", "--sk-primary"]],
  ["background", ["--bg", "--background", "--sk-bg"]],
  ["surface", ["--surface", "--card", "--sk-surface"]],
  ["text", ["--text", "--foreground", "--sk-text"]],
  ["border", ["--border", "--sk-border"]],
];

/** Relative luminance (WCAG) — decides whether onPrimary should be dark. */
function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = ch.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

/** `#20a0ff` / `rgba(...)` / `var(--x)` -> `#RRGGBB`, or null when unresolvable. */
export function resolveColor(raw: string, tokens: Map<string, string>): string | null {
  let v = raw.trim();
  for (let hop = 0; hop < 6 && v.startsWith("var("); hop++) {
    const name = v.slice(4, v.indexOf(")")).trim();
    const next = tokens.get(name);
    if (!next) return null;
    v = next.trim();
  }
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(v);
  if (m) {
    const h = m[1]!.toLowerCase();
    return "#" + (h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6));
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (rgb) {
    const parts = rgb[1]!.split(/[,/\s]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
      return (
        "#" +
        parts
          .slice(0, 3)
          .map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0"))
          .join("")
      );
    }
  }
  return null;
}

/** Read the site's palette out of its stylesheet's `:root` tokens. */
export function sitePalette(css: string): Record<string, string> {
  const tokens = new Map<string, string>();
  for (const m of css.matchAll(/:root\s*\{([\s\S]*?)\}/g)) {
    for (const d of m[1]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      tokens.set(d[1]!, d[2]!);
    }
  }
  const out: Record<string, string> = {};
  for (const [slot, names] of PALETTE_SLOTS) {
    for (const name of names) {
      const raw = tokens.get(name);
      if (!raw) continue;
      const color = resolveColor(raw, tokens);
      if (color) {
        out[slot] = color;
        break;
      }
    }
  }
  return out;
}

// `static const x = Color(...)` — the const rides the declaration, not the value.
const dartColor = (hex: string): string => `Color(0xFF${hex.slice(1).toUpperCase()})`;

/** Emit lib/site_theme.dart and point main.dart's ThemeData at it. */
export function applyFlutterTheme(outDir: string, target: string): StyleApplyResult | null {
  const mainDart = path.join(outDir, "lib", "main.dart");
  if (!existsSync(mainDart)) return null;

  const { css, source } = siteStylesheet();
  if (!css.trim()) return null;
  const palette = sitePalette(css);
  if (!palette.primary) return null;

  const primary = palette.primary!;
  const onPrimary = luminance(primary) > 0.5 ? "#1f2d3d" : "#ffffff";
  const background = palette.background ?? "#ffffff";
  const surface = palette.surface ?? "#ffffff";
  const text = palette.text ?? (luminance(background) > 0.5 ? "#1f2d3d" : "#f0f2f7");

  const theme = `// Generated by tools/export-style.mts from ${source}.
// The exporter ships a hardcoded seed colour, so the exported Flutter app
// carried none of the site's look (BUG.md CF). These are the theme's own
// design tokens, resolved through var() chains to literal colours.
import 'package:flutter/material.dart';

/// The site's palette, straight out of its stylesheet tokens.
class RoseSiteTheme {
  RoseSiteTheme._();

  static const primary = ${dartColor(primary)};
  static const onPrimary = ${dartColor(onPrimary)};
  static const background = ${dartColor(background)};
  static const surface = ${dartColor(surface)};
  static const onSurface = ${dartColor(text)};
${palette.border ? `  static const border = ${dartColor(palette.border!)};\n` : ""}
  static ThemeData theme({Brightness brightness = Brightness.light}) {
    final scheme = ColorScheme.fromSeed(
      seedColor: primary,
      brightness: brightness,
      primary: primary,
      onPrimary: onPrimary,
      surface: surface,
      onSurface: onSurface,
    );
    return ThemeData(
      useMaterial3: true,
      brightness: brightness,
      colorScheme: scheme,
      scaffoldBackgroundColor: background,
    );
  }
}
`;
  writeFileSync(path.join(outDir, "lib", "site_theme.dart"), theme, "utf8");

  const src = readFileSync(mainDart, "utf8");
  if (src.includes("RoseSiteTheme")) return null; // already wired
  const seeded = matchThemeData(src);
  if (!seeded) {
    return { target, file: path.relative(ROOT, path.join(outDir, "lib", "site_theme.dart")), bytes: Buffer.byteLength(theme), dropped: ["main.dart theme line not found - theme.dart emitted, wire it by hand"] };
  }
  const patched = src
    .replace(seeded, "theme: RoseSiteTheme.theme()")
    .replace(
      /(import\s+'(?:package:flutter\/material\.dart|vectors\.dart)';)/,
      (m) => `${m}\nimport 'site_theme.dart';`,
    );
  if (!patched.includes("import 'site_theme.dart';")) {
    // No anchor import to hang ours on: put it above the first import.
    writeFileSync(mainDart, "import 'site_theme.dart';\n" + patched, "utf8");
  } else {
    writeFileSync(mainDart, patched, "utf8");
  }
  return {
    target,
    file: path.relative(ROOT, mainDart),
    bytes: Buffer.byteLength(theme),
    dropped: [],
  };
}

export function applyExportStyles(outDir: string, target: string): StyleApplyResult | null {
  if (target === "flutter") return applyFlutterTheme(outDir, target);

  const ext = MINI_STYLE[target];
  if (!ext) return null; // other families get their own pass later
  const appStyle = path.join(outDir, `app.${ext}`);
  if (!existsSync(appStyle)) return null;

  const { css, source } = siteStylesheet();
  if (!css.trim()) return null;

  const { css: safe, dropped } = sanitizeForMiniProgram(css);
  if (!safe.trim()) return null;

  const existing = readFileSync(appStyle, "utf8");
  // A future exporter may carry the skin itself (BUG.md CF asks for a
  // globalCss option). Appending then would double the payload, so bail when
  // the file already knows the site's tokens.
  if (rootTokenNames(css).some((name) => existing.includes(name))) return null;

  const banner =
    `\n/* ---- site skin (${source}) ----\n` +
    ` * Appended by tools/export-style.mts: the exporter only carries .rose\n` +
    ` * <style> blocks, so the site's chrome stylesheet and design tokens would\n` +
    ` * otherwise be missing entirely. Filtered for this target: ${dropped.length} block(s) dropped.\n` +
    ` */\n`;
  writeFileSync(appStyle, existing + banner + safe + "\n", "utf8");
  return { target, file: path.relative(ROOT, appStyle), bytes: Buffer.byteLength(safe), dropped };
}

// CLI: node --import tsx tools/export-style.mts <outDir> <target>
const argv = process.argv.slice(2);
if (argv.length >= 2) {
  const res = applyExportStyles(path.resolve(argv[0]!), argv[1]!);
  if (!res) {
    console.log("[export-style] nothing to do (no app stylesheet, no site skin, or unsupported family)");
  } else {
    console.log(`[export-style] ${res.target}: +${res.bytes} bytes -> ${res.file}`);
    for (const d of res.dropped) console.warn(`[export-style] dropped: ${d}`);
  }
}
