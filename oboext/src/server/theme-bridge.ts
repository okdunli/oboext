// Theme colour helpers for the chrome head.

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

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const rgbToHex = ([r, g, b]: RGB) =>
  "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

// Browser-UI tint for the resolved background token. Derived, never
// hardcoded: HSL lightness <= 45% means a dark-only surface, so one
// unprefixed meta is correct under either OS preference; a light background
// means the theme ships a night mode, and the dark meta reuses the same
// hue-preserving L16 derivation (hsl(h, clamped s, 16)) that a dark scheme
// would apply to --bg, so tint and stylesheet agree by construction.
// Unparseable input yields "".
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
