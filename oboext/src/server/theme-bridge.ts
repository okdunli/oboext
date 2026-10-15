// Skyscraper token bridge.
import type { ThemeConfig } from "./schema.js";

type RGB = [number, number, number];

/** #rgb / #rrggbb / rgb() / rgba() → [r,g,b]; null for anything fancier. */
function parseColor(input: string | undefined | null): RGB | null {
  if (!input) return null;
  const s = String(input).trim();
  let m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}

function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s * 100, l * 100];
}

const hsl = (h: number, s: number, l: number) =>
  `hsl(${Math.round(((h % 360) + 360) % 360)},${Math.round(Math.max(0, Math.min(100, s)))}%,${Math.round(Math.max(0, Math.min(100, l)))}%)`;

/** Linear blend toward white (ArtTint's mixWhite). */
const mixWhite = ([r, g, b]: RGB, t: number) =>
  `rgb(${Math.round(r + (255 - r) * t)},${Math.round(g + (255 - g) * t)},${Math.round(b + (255 - b) * t)})`;

const rgba = ([r, g, b]: RGB, a: number) =>
  `rgba(${r},${g},${b},${a})`;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, "");

/**
 * Declarations appended inside rv-theme-vars' :root block (no enclosing
 * braces). Only tokens the admin actually changed (vs manifest baseline)
 * are derived; colours that fail to parse simply skip their derived rows, so
 * a hand-typed hsl() accent can never blank the whole block.
 */
export function skyscraperBridgeRoot(
  c: ThemeConfig,
  base: ThemeConfig,
): string {
  const d: string[] = [];
  if (norm(c.accent) !== norm(base.accent)) {
    const accent = parseColor(c.accent);
    if (accent) {
      const [h, s, l] = rgbToHsl(accent);
      d.push(`--sk-primary:${c.accent}`);
      d.push(`--sk-primary-l1:${mixWhite(accent, 0.18)}`);
      d.push(`--sk-primary-l2:${mixWhite(accent, 0.36)}`);
      d.push(`--sk-primary-l3:${mixWhite(accent, 0.55)}`);
      d.push(`--sk-primary-d1:${hsl(h, s, l - 6)}`);
      d.push(`--sk-primary-d2:${hsl(h, s, l - 13)}`);
      d.push(`--sk-primary-d3:${hsl(h, s, l - 19)}`);
      d.push(`--sk-analogous:${hsl(h + 12, s, l + 3)}`);
      d.push(`--sk-analogous-d1:${hsl(h + 12, s, l - 6)}`);
      d.push(`--sk-po0:${rgba(accent, 0)}`);
      d.push(`--sk-po1:${rgba(accent, 0.1)}`);
      d.push(`--sk-po2:${rgba(accent, 0.2)}`);
      d.push(`--sk-po3:${rgba(accent, 0.3)}`);
      d.push(`--sk-po4:${rgba(accent, 0.4)}`);
      d.push(`--sk-po6:${rgba(accent, 0.6)}`);
    } else if (c.accent) {
      d.push(`--sk-primary:${c.accent}`);
    }
  }

  if (norm(c.background) !== norm(base.background) && c.background)
    d.push(`--sk-bg:${c.background}`);
  if (norm(c.surface) !== norm(base.surface) && c.surface)
    d.push(`--sk-surface:${c.surface}`);
  if (norm(c.surfaceAlt) !== norm(base.surfaceAlt) && c.surfaceAlt)
    d.push(`--sk-border:${c.surfaceAlt}`);
  if (norm(c.border) !== norm(base.border) && c.border)
    d.push(`--sk-border-strong:${c.border}`);
  if (norm(c.text) !== norm(base.text) && c.text) {
    d.push(`--sk-text:${c.text}`);
    const strong = parseColor(c.text);
    if (strong) {
      const [h, s, l] = rgbToHsl(strong);
      d.push(`--sk-text-strong:${hsl(h, s + 10, l - 16)}`);
      // Element shadows follow the text ramp (default scale uses gray-0).
      d.push(`--sk-go0:${rgba(strong, 0)}`);
      d.push(`--sk-go1:${rgba(strong, 0.1)}`);
      d.push(`--sk-go2:${rgba(strong, 0.2)}`);
      d.push(`--sk-go3:${rgba(strong, 0.3)}`);
      d.push(`--sk-go5:${rgba(strong, 0.5)}`);
      d.push(`--sk-go8:${rgba(strong, 0.8)}`);
    }
  }
  if (norm(c.muted) !== norm(base.muted) && c.muted)
    d.push(`--sk-muted:${c.muted}`, `--sk-gray-4:${c.muted}`);
  if (norm(c.codeBg) !== norm(base.codeBg) && c.codeBg)
    d.push(`--sk-code-bg:${c.codeBg}`);
  if (norm(c.radius) !== norm(base.radius) && c.radius)
    d.push(`--sk-radius:${c.radius}`);
  return d.join(";");
}

/**
 * Dark-scheme counterpart for the SAME changed tokens. theme.css ships
 * hardcoded dark literals under [data-color-scheme="dark"], which would
 * otherwise ignore saved tokens for night visitors. Hue-preserving
 * lightness ramps keep identity while moving surfaces into the 16–33%
 * band; accent stays as saved (it reads on dark). Tokens left at baseline
 * keep theme.css' static dark values.
 */
export function skyscraperBridgeDark(
  c: ThemeConfig,
  base: ThemeConfig,
): string {
  const d: string[] = [];
  if (norm(c.background) !== norm(base.background)) {
    const bg = parseColor(c.background);
    if (bg) {
      const [h, s] = rgbToHsl(bg);
      const ss = clamp(s, 12, 42);
      const bgDark = hsl(h, ss, 16);
      d.push(`--sk-bg:${bgDark}`, `--bg:${bgDark}`, `--background:${bgDark}`);
      d.push(`--sk-border:${hsl(h, ss, 27)}`);
      d.push(`--sk-border-strong:${hsl(h, ss, 33)}`);
    }
  }
  if (norm(c.surface) !== norm(base.surface)) {
    const surface = parseColor(c.surface);
    if (surface) {
      const [h, s] = rgbToHsl(surface);
      const sd = hsl(h, clamp(s, 12, 42), 20);
      d.push(`--sk-surface:${sd}`, `--surface:${sd}`);
    }
  }
  if (norm(c.text) !== norm(base.text)) {
    const t = parseColor(c.text);
    if (t) {
      const [h, s] = rgbToHsl(t);
      const ss = clamp(s, 15, 35);
      d.push(`--sk-text:${hsl(h, ss, 72)}`, `--text:${hsl(h, ss, 72)}`);
      d.push(`--sk-text-strong:${hsl(h, ss, 89)}`);
    }
  }
  if (norm(c.muted) !== norm(base.muted)) {
    const m = parseColor(c.muted);
    if (m) {
      const [h, s] = rgbToHsl(m);
      const md = hsl(h, clamp(s, 10, 30), 62);
      d.push(`--sk-muted:${md}`, `--muted:${md}`);
    }
  }
  if (norm(c.codeBg) !== norm(base.codeBg)) {
    const cb = parseColor(c.codeBg);
    if (cb) {
      const [h, s] = rgbToHsl(cb);
      d.push(`--sk-code-bg:${hsl(h, clamp(s, 20, 50), 15)}`);
    }
  }
  if (d.length && norm(c.accent) !== norm(base.accent) && c.accent)
    d.push(`--accent:${c.accent}`);
  return d.join(";");
}

const rgbToHex = ([r, g, b]: RGB) =>
  "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

// Browser-UI tint for the resolved background token. Derived, never
// hardcoded: HSL lightness <= 45% means a dark-only surface, so one
// unprefixed meta is correct under either OS preference; a light background
// means the theme ships a night mode, and the dark meta reuses the same
// hue-preserving L16 derivation skyscraperBridgeDark() applies to --bg, so
// tint and stylesheet agree by construction. Unparseable input yields "".
export function themeColorMetas(bg: string | undefined | null): string {
  const rgb = parseColor(bg);
  if (!rgb) return "";
  const light = rgbToHex(rgb);
  const [h, s, l] = rgbToHsl(rgb);
  if (l <= 45) return `<meta name="theme-color" content="${light}">`;
  const dark = hsl(h, clamp(s, 12, 42), 16);
  return (
    `<meta name="theme-color" content="${light}" media="(prefers-color-scheme: light)">` +
    `<meta name="theme-color" content="${dark}" media="(prefers-color-scheme: dark)">`
  );
}
