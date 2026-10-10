import type { ThemeConfig } from "./schema.js";





export type PaletteTokens = Pick<
  ThemeConfig,
  | "background"
  | "surface"
  | "surfaceAlt"
  | "text"
  | "muted"
  | "accent"
  | "accentText"
  | "accentSoft"
  | "border"
  | "link"
  | "linkHover"
  | "headerBg"
  | "footerBg"
  | "codeBg"
  | "shadow"
  | "gradient"
  | "colorScheme"
>;

export interface PalettePreset {

  key: string;

  label: string;

  description: string;

  dark: boolean;
  tokens: PaletteTokens;
}


const INDIGO: PaletteTokens = {
  background: "#0b0d12",
  surface: "#161922",
  surfaceAlt: "#1b1f2a",
  text: "#e8eaf0",
  muted: "#9aa3b2",
  accent: "#7c8cff",
  accentText: "#0b0d12",
  accentSoft: "rgba(124,140,255,0.16)",
  border: "#262b36",
  link: "#a5b4fc",
  linkHover: "#c7d2fe",
  headerBg: "rgba(11,13,18,0.72)",
  footerBg: "#0c0f16",
  codeBg: "#11141c",
  shadow: "0 10px 30px rgba(0,0,0,0.35)",
  gradient: "linear-gradient(135deg,#7c8cff,#c084fc)",
  colorScheme: "dark",
};


const THYUU: PaletteTokens = {
  background: "#171a21",
  surface: "rgba(255,255,255,0.06)",
  surfaceAlt: "rgba(255,255,255,0.04)",
  text: "rgba(255,255,255,0.9)",
  muted: "rgba(255,255,255,0.55)",
  accent: "#FFB020",
  accentText: "#1a1208",
  accentSoft: "rgba(255,176,32,0.16)",
  border: "rgba(255,255,255,0.1)",
  link: "#ffc44d",
  linkHover: "#ffe08a",
  headerBg: "rgba(15,17,22,0.7)",
  footerBg: "rgba(10,12,16,0.92)",
  codeBg: "rgba(255,255,255,0.06)",
  shadow: "0 10px 30px rgba(0,0,0,0.4)",
  gradient: "linear-gradient(135deg,#FFB020,#ffd98a)",
  colorScheme: "dark",
};


const SAMSARA: PaletteTokens = {
  background: "#23272e",
  surface: "rgba(255,255,255,0.07)",
  surfaceAlt: "rgba(255,255,255,0.04)",
  text: "rgba(255,255,255,0.92)",
  muted: "rgba(255,255,255,0.55)",
  accent: "#FFA000",
  accentText: "#1a1a1a",
  accentSoft: "rgba(255,160,0,0.16)",
  border: "rgba(255,255,255,0.12)",
  link: "#FFB020",
  linkHover: "#ffc94d",
  headerBg: "rgba(20,24,30,0.7)",
  footerBg: "rgba(15,18,23,0.92)",
  codeBg: "rgba(255,255,255,0.06)",
  shadow: "0 8px 24px rgba(0,0,0,0.35)",
  gradient: "linear-gradient(135deg,#FFA000,#ffd166)",
  colorScheme: "dark",
};


const WRITER: PaletteTokens = {
  background: "#fbfaf7",
  surface: "#ffffff",
  surfaceAlt: "#f4f2ec",
  text: "#2b2b2b",
  muted: "#8a8a7a",
  accent: "#3256b3",
  accentText: "#ffffff",
  accentSoft: "rgba(50,86,179,0.12)",
  border: "#e6e2d8",
  link: "#3256b3",
  linkHover: "#22397d",
  headerBg: "rgba(251,250,247,0.86)",
  footerBg: "#f1efe9",
  codeBg: "#f4f2ec",
  shadow: "0 4px 16px rgba(40,40,30,0.06)",
  gradient: "linear-gradient(135deg,#3256b3,#5b7fd6)",
  colorScheme: "light",
};


const SOMNIA: PaletteTokens = {
  background: "#f6f6f7",
  surface: "#ffffff",
  surfaceAlt: "#f0f0f2",
  text: "#1f2430",
  muted: "#6b7280",
  accent: "#e26d6d",
  accentText: "#ffffff",
  accentSoft: "rgba(226,109,109,0.14)",
  border: "#e7e7ec",
  link: "#e26d6d",
  linkHover: "#c94f4f",
  headerBg: "rgba(255,255,255,0.82)",
  footerBg: "#f1f1f3",
  codeBg: "#f3f3f5",
  shadow: "0 6px 22px rgba(20,20,40,0.08)",
  gradient: "linear-gradient(135deg,#e26d6d,#f0a36b)",
  colorScheme: "light",
};


const VAPOR: PaletteTokens = {
  background: "#e5e9ef",
  surface: "#f0f2f7",
  surfaceAlt: "#e9edf3",
  text: "#3a4250",
  muted: "#7a828f",
  accent: "#5b8def",
  accentText: "#ffffff",
  accentSoft: "rgba(91,141,239,0.14)",
  border: "#c8d2de",
  link: "#5b8def",
  linkHover: "#3f6fd0",
  headerBg: "rgba(229,233,239,0.85)",
  footerBg: "#dae0e8",
  codeBg: "#e9edf3",
  shadow: "0 4px 14px rgba(30,40,60,0.08)",
  gradient: "linear-gradient(135deg,#5b8def,#8fb6f2)",
  colorScheme: "light",
};


export const PALETTE_PRESETS: PalettePreset[] = [
  {
    key: "indigo",
    label: "靛蓝夜色（默认）",
    description: "深色底 + 靛紫强调，冷静克制的原厂风格。",
    dark: true,
    tokens: INDIGO,
  },
  {
    key: "thyuu",
    label: "星度 · 暖金深空",
    description: "深色星空底 + 暖金 #FFB020 强调，沉浸感强。",
    dark: true,
    tokens: THYUU,
  },
  {
    key: "samsara",
    label: "萨姆萨拉 · 玻璃金",
    description: "深炭灰玻璃底 + 金色 #FFA000，适合配毛玻璃效果。",
    dark: true,
    tokens: SAMSARA,
  },
  {
    key: "writer",
    label: "写作者 · 暖纸白",
    description: "暖纸白底 + 海军蓝，长文阅读友好。",
    dark: false,
    tokens: WRITER,
  },
  {
    key: "somnia",
    label: "索姆尼亚 · 近白珊瑚",
    description: "近白底 + 珊瑚红，干净明亮偏杂志感。",
    dark: false,
    tokens: SOMNIA,
  },
  {
    key: "vapor",
    label: "蒸气 · 冷灰蓝",
    description: "冷灰蓝底 + 亮蓝链接，极简冷静。",
    dark: false,
    tokens: VAPOR,
  },
];

const BY_KEY = new Map(PALETTE_PRESETS.map((p) => [p.key, p]));


export function getPalettePreset(key: string | null | undefined): PalettePreset | null {
  if (!key) return null;
  return BY_KEY.get(key) ?? null;
}



export function paletteLayeredConfig(
  config: ThemeConfig | null | undefined,
  baseline: Partial<ThemeConfig>,
  key: string | null | undefined,
): ThemeConfig {
  const base = baseline as Record<string, unknown>;
  const real: Record<string, string> = {};
  for (const [k, v] of Object.entries((config ?? {}) as Record<string, unknown>)) {
    const s = typeof v === "string" ? v.trim() : "";
    if (!s) continue;
    if (typeof base[k] === "string" && String(base[k]).trim() === s) continue;
    real[k] = s;
  }
  const preset = getPalettePreset(key);
  return { ...base, ...(preset?.tokens ?? {}), ...real } as ThemeConfig;
}


export function paletteTokenKeys(): string[] {
  return Object.keys(PALETTE_PRESETS[0]?.tokens ?? {});
}


export function isDarkPalette(key: string | null | undefined): boolean {
  return getPalettePreset(key)?.dark ?? true;
}
