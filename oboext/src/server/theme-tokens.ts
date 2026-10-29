// Factory theme tokens — port of lib/theme.ts (React.CSSProperties helper dropped: the admin preview builds CSS text instead).
import type { ThemeConfig } from "./schema.js";

export const DEFAULT_THEME_CONFIG: Required<ThemeConfig> = {
  // Palette
  background: "#09090b",
  surface: "#18181b",
  surfaceAlt: "#1f1f23",
  text: "#f4f4f5",
  muted: "#a1a1aa",
  accent: "#818cf8",
  accentText: "#ffffff",
  accentSoft: "rgba(129,140,248,0.16)",
  border: "#27272a",
  link: "#a5b4fc",
  linkHover: "#c7d2fe",
  success: "#34d399",
  warning: "#fbbf24",
  danger: "#f87171",
  headerBg: "rgba(9,9,11,0.72)",
  footerBg: "#0c0c0f",
  codeBg: "#111114",

  // Shape & motion
  radius: "12px",
  radiusLarge: "22px",
  borderWidth: "1px",
  shadow: "0 10px 30px rgba(0,0,0,0.35)",
  transition: "200ms cubic-bezier(0.4,0,0.2,1)",

  // Typography
  font: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif",
  fontHeading: "inherit",
  fontMono:
    "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
  fontSize: "16px",
  lineHeight: "1.75",
  letterSpacing: "0em",
  headingWeight: "700",

  // Layout
  containerWidth: "1200px",
  contentWidth: "760px",
  sidebar: "none",
  density: "normal",
  listStyle: "list",
  gridColumns: "3",
  headerMode: "sticky",

  // Effects
  glass: "off",
  glassBlur: "14px",
  noise: "off",
  gradient: "linear-gradient(135deg,#818cf8,#c084fc)",

  // Native UI scheme (scrollbars / form controls)
  colorScheme: "dark",

  // Escape hatch
  customCss: "",
};

function tokenToCssVar(key: string): string {
  return `--${key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
}

const NON_CSS_KEYS = new Set<keyof ThemeConfig>(["customCss"]);

// A single malformed token value (e.g. "#fff}*{display:none") would close the
// :root{...} block early and inject arbitrary rules, taking the whole
// stylesheet down. Strip the characters that can end a declaration/block or
// open markup; every legitimate token value (colors, lengths, font stacks,
// gradients) is free of them. customCss is the admin's explicit escape hatch
// and is emitted elsewhere, unsanitized by design.
function sanitizeTokenValue(v: string): string {
  return v.replace(/[;{}<>]/g, "").replace(/[\r\n]+/g, " ");
}

function merged(config: ThemeConfig | null | undefined): Required<ThemeConfig> {
  // Drop empty strings so a blank field falls back to the default instead of
  // emitting `--accent:;` and breaking the whole declaration block.
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(config ?? {})) {
    if (typeof v === "string" && v.trim() !== "") clean[k] = v;
  }
  return { ...DEFAULT_THEME_CONFIG, ...clean } as Required<ThemeConfig>;
}

/** Serialize a theme config into CSS custom properties for a :root block. */
export function themeToCss(config: ThemeConfig | null | undefined): string {
  const c = merged(config);
  const decls: string[] = [];
  for (const [key, value] of Object.entries(c)) {
    if (NON_CSS_KEYS.has(key as keyof ThemeConfig)) continue;
    decls.push(`${tokenToCssVar(key)}:${sanitizeTokenValue(value)}`);
  }
  decls.push(`--bg:${sanitizeTokenValue(c.background)}`);
  decls.push(`color-scheme:${sanitizeTokenValue(c.colorScheme) || "dark"}`);
  return decls.join(";");
}

/** Resolve the effective config (defaults + overrides). */
export function resolveThemeConfig(
  config: ThemeConfig | null | undefined,
): Required<ThemeConfig> {
  return merged(config);
}

/** Helper for themes: read a boolean-ish token ("on"/"off"/"true"/"1"). */
export function isOn(value: string | undefined | null): boolean {
  if (!value) return false;
  return ["on", "true", "1", "yes", "enabled"].includes(value.toLowerCase());
}
