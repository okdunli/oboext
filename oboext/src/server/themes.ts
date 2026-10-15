// Theme service — port of lib/services/themes.ts + the filesystem half of themes/registry.ts.
import { desc, eq, inArray, sql } from "drizzle-orm";
import fs from "fs";
import path from "path";
import { db } from "./db.js";
import { siteSettings, themes, type Theme, type ThemeConfig } from "./schema.js";
import { SIDEBAR_TTL, invalidatePrefix, memoQuery, memoStrict } from "./cache.js";
import { ServiceError } from "./admin.js";
import { rmSyncRetry } from "./fs-utils.js";
import { installPackage } from "./package-install.js";
import {
  coerceSettings,
  resolveSettings,
  type SettingField,
  type SettingsSchema,
} from "./settings-schema.js";
import { DEFAULT_THEME_CONFIG, resolveThemeConfig } from "./theme-tokens.js";
import { getPalettePreset, paletteLayeredConfig, PALETTE_PRESETS } from "./theme-palettes.js";
import { THEME_CONFIG_KEYS, THEME_CONFIG_SCHEMA } from "./theme-schema.js";
import { createLogger } from "./logger.js";
const log = createLogger("themes");

// ------------------------------------------------------------- manifest types

export type ThemeWidgetArea = {
  key: string;
  label: string;
  description?: string;
};

export type ThemeMeta = {
  description?: string;
  version?: string;
  author?: string;
  homepage?: string | null;
  updatedAt?: string | null;
};

export type ThemeManifest = {
  name: string;
  slug: string;
  description: string;
  version: string;
  author: string;
  homepage?: string;
  updatedAt?: string;
  isDefault: boolean;
  config: ThemeConfig;
  screenshot?: string;
  tags?: string[];
  settingsSchema?: unknown;
  widgetAreas?: ThemeWidgetArea[];
  supports?: string[];
};

const THEMES_DIR = path.join(process.cwd(), "themes");

// Themes whose public chrome is actually ported to rosefd renderers.
export const PORTED_PUBLIC_THEMES = new Set(["skyscraper", "default", "pseudolinear", "codeman", "bluemix"]);

export function isPublicThemePorted(slug: string): boolean {
  return PORTED_PUBLIC_THEMES.has(slug);
}

// Hard TTL for the active-theme reads.
const ACTIVE_THEME_TTL = 30_000;

/** Areas every theme gets for free, so widgets work in minimal themes. */
export const BASE_WIDGET_AREAS: ThemeWidgetArea[] = [
  { key: "sidebar", label: "侧边栏", description: "文章与列表页的侧栏，需在「布局」中开启侧边栏" },
  { key: "footer", label: "页脚", description: "页面底部的多栏区域" },
];

// --------------------------------------------------------------- discovery

let discoveryCache: ThemeManifest[] | null = null;

/** Scan themes/ — each subdirectory carrying a manifest.json is a theme. */
export function discoverThemes(): ThemeManifest[] {
  if (discoveryCache) return discoveryCache;
  const found: ThemeManifest[] = [];
  if (fs.existsSync(THEMES_DIR)) {
    for (const entry of fs.readdirSync(THEMES_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(THEMES_DIR, entry.name, "manifest.json");
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as ThemeManifest;
        // Trust the folder name over a mistyped slug so routing never breaks.
        manifest.slug = manifest.slug || entry.name;
        if (!manifest.updatedAt) {
          try {
            manifest.updatedAt = fs.statSync(manifestPath).mtime.toISOString().slice(0, 10);
          } catch {
            /* keep empty */
          }
        }
        found.push(manifest);
      } catch {
        // Skip invalid manifests.
      }
    }
  }
  discoveryCache = found;
  return found;
}

/** Drop the memoised manifest scan (after admin-side folder changes). */
export function invalidateThemeDiscovery(): void {
  discoveryCache = null;
}

export function getThemeManifest(slug: string): ThemeManifest | null {
  return discoverThemes().find((t) => t.slug === slug) ?? null;
}

/** Read-only meta for admin cards (only manifest carries version/author). */
export function getThemeMeta(slug: string): ThemeMeta | null {
  const m = getThemeManifest(slug);
  if (!m) return null;
  return {
    description: m.description,
    version: m.version,
    author: m.author,
    homepage: m.homepage ?? null,
    updatedAt: m.updatedAt ?? null,
  };
}

// A theme's own settings schema.
export function getThemeSettingsSchema(slug: string): SettingsSchema {
  const raw = getThemeManifest(slug)?.settingsSchema;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as SettingsSchema;
  const sections = (raw as { sections?: unknown }).sections;
  if (!Array.isArray(sections)) return [];
  return (sections as Array<Record<string, unknown>>).map((s, i) => ({
    key: typeof s.key === "string" && s.key ? s.key : `sec-${i}`,
    label:
      (typeof s.label === "string" && s.label) ||
      (typeof s.title === "string" && s.title) ||
      `Section ${i + 1}`,
    ...(typeof s.description === "string" ? { description: s.description } : {}),
    ...(typeof s.icon === "string" ? { icon: s.icon } : {}),
    fields: Array.isArray(s.fields) ? (s.fields as SettingField[]) : [],
  }));
}

/** Declared areas plus the base areas a theme didn't redeclare. */
export function getThemeWidgetAreas(slug: string): ThemeWidgetArea[] {
  const declared = getThemeManifest(slug)?.widgetAreas ?? [];
  const keys = new Set(declared.map((a) => a.key));
  return [...declared, ...BASE_WIDGET_AREAS.filter((a) => !keys.has(a.key))];
}

// ----------------------------------------------------------- DB synchronise

/**
 * Mirror themes/ into the `themes` table. Upserts refresh only name /
 * isDefault (never the user's saved config/settings); rows whose folder is
 * gone are pruned, so deleting a folder removes it from the admin at once.
 */
export async function syncThemes(): Promise<void> {
  const manifests = discoverThemes();
  const discovered = new Set(manifests.map((m) => m.slug));
  // One multi-row upsert and one delete rather than a round trip per folder:
  // the remote-Postgres round trips, not the rows, are the cost here.
  if (manifests.length > 0) {
    await db
      .insert(themes)
      .values(
        manifests.map((m) => ({
          name: m.name,
          slug: m.slug,
          isDefault: m.isDefault,
          config: m.config,
        })),
      )
      .onConflictDoUpdate({
        target: themes.slug,
        set: { name: sql`excluded."name"`, isDefault: sql`excluded."is_default"` },
      });
  }
  const rows = await db.select({ slug: themes.slug }).from(themes);
  const stale = rows.map((r) => r.slug).filter((s) => !discovered.has(s));
  if (stale.length > 0) await db.delete(themes).where(inArray(themes.slug, stale));
  // Heal an active theme whose public chrome isn't ported yet: keep the
  // site on the newest ported layout instead of silently rendering the
  // skyscraper chrome under another theme's token set (T20 ports the rest).
  const [s] = await db
    .select({ activeThemeSlug: siteSettings.activeThemeSlug })
    .from(siteSettings)
    .where(eq(siteSettings.id, 1));
  const active = s?.activeThemeSlug || "default";
  if (discovered.has(active) && !PORTED_PUBLIC_THEMES.has(active)) {
    const target =
      manifests.find((m) => PORTED_PUBLIC_THEMES.has(m.slug)) ??
      manifests.find((m) => m.isDefault) ??
      null;
    if (target) {
      await db
        .update(siteSettings)
        .set({ activeThemeSlug: target.slug })
        .where(eq(siteSettings.id, 1));
    }
  }
}

// Process-level memo (mirrors ensureDefaultMenus): the public chrome calls
// getActiveTheme() on every request, but folder sync is a startup concern.
let synced = false;
let syncPromise: Promise<void> | null = null;
export function ensureThemes(): Promise<void> {
  if (synced) return Promise.resolve();
  if (!syncPromise) {
    syncPromise = syncThemes()
      .then(() => {
        synced = true;
        syncPromise = null;
      })
      .catch((e) => {
        syncPromise = null;
        // Deliberately swallowed. ensureThemes() sits on the PUBLIC render hot
        // path (getActiveThemeSlug -> chromeData / post page), and syncThemes()
        // is a maintenance write (upsert + delete + settings update). Letting
        // that write's failure propagate turned one dropped connection into a
        // 500 for every page of the site. The disk scan inside syncThemes()
        // already ran, so reads keep working off the existing rows; the next
        // cold start retries the sync. Marking `synced` here would be wrong -
        // that would skip the write forever - so only the error is dropped.
        log.warn(
          "[themes] folder sync failed; serving reads from the existing rows: " +
            (e instanceof Error ? e.message : String(e)),
        );
      });
  }
  return syncPromise;
}

// -------------------------------------------------------------------- reads

function slugifyName(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9一-龥]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || `theme-${Date.now()}`
  );
}

/** Admin list: low-frequency path rescans the disk so deletes show at once. */
export async function listThemes(): Promise<Theme[]> {
  invalidateThemeDiscovery();
  await syncThemes();
  synced = true;
  return db.select().from(themes).orderBy(desc(themes.isDefault), desc(themes.createdAt));
}

export async function getThemeBySlug(slug: string): Promise<Theme | null> {
  await ensureThemes();
  const [row] = await db.select().from(themes).where(eq(themes.slug, slug));
  return row ?? null;
}

export async function getThemeById(id: number): Promise<Theme> {
  await ensureThemes();
  const [row] = await db.select().from(themes).where(eq(themes.id, id));
  if (!row) throw new ServiceError("主题不存在", 404);
  return row;
}

/** Drop the memoized active-theme reads; call after any write to
 * themes/siteSettings.activeThemeSlug so the public chrome picks the change
 * up immediately instead of waiting out the SWR TTL. */
export function invalidateActiveThemeCache(): void {
  invalidatePrefix("theme:active");
}

/** Current activeThemeSlug from site_settings ("default" when uninitialised). */
export async function getActiveThemeSlug(): Promise<string> {
  await ensureThemes();
  // memoStrict, not memoQuery: a stale slug renders the WRONG theme, and this
  // read gates every chrome decision on the page. The SWR window (5x ttl)
  // kept a switched theme invisible for up to 150s.
  return memoStrict("theme:active:slug", ACTIVE_THEME_TTL, async () => {
    const [s] = await db
      .select({ activeThemeSlug: siteSettings.activeThemeSlug })
      .from(siteSettings)
      .where(eq(siteSettings.id, 1));
    return s?.activeThemeSlug || "default";
  });
}

/**
 * The site's active theme row. A missing active folder falls back to the
 * default discovered theme and rewrites the setting so it heals itself.
 *
 * Memoized (SWR, 30s): the chrome render path calls getActiveTheme two or
 * three times per request (settings + render config + theme slug), each of
 * which used to cost a fresh site_settings + themes round trip — painful
 * where RTT is ~300ms (Neon on Vercel).
 */
export async function getActiveTheme(): Promise<Theme> {
  await ensureThemes();
  // memoStrict for the same reason as getActiveThemeSlug - this row decides
  // which chrome object renders the page.
  return memoStrict("theme:active:row", ACTIVE_THEME_TTL, async (): Promise<Theme> => {
    const [settings] = await db
      .select()
      .from(siteSettings)
      .where(eq(siteSettings.id, 1));
    let slug = settings?.activeThemeSlug || "default";
    if (!getThemeManifest(slug)) {
      const discovered = discoverThemes();
      const fallback = discovered.find((t) => t.isDefault) ?? discovered[0] ?? null;
      if (fallback) {
        slug = fallback.slug;
        await db
          .update(siteSettings)
          .set({ activeThemeSlug: slug })
          .where(eq(siteSettings.id, 1));
      }
    }
    const [theme] = await db.select().from(themes).where(eq(themes.slug, slug));
    if (theme) return theme;
    const [def] = await db.select().from(themes).where(eq(themes.isDefault, true));
    if (def) return def;
    const [anyTheme] = await db.select().from(themes).limit(1);
    if (anyTheme) return anyTheme;
    throw new ServiceError("没有可用主题", 500);
  });
}

// ------------------------------------------------------------------- writes

export type ThemeInput = {
  name: string;
  slug?: string;
  config?: ThemeConfig;
  settings?: Record<string, unknown>;
};

/** Recursively copy a directory. */
function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * Scaffold a new auto-discoverable folder from themes/default. manifest.json
 * is rewritten (name/slug/isDefault, optional config override); index.ts's
 * slug constant is rewritten too so the source doesn't lie.
 */
function copyThemeTemplate(
  tpl: string,
  dest: string,
  slug: string,
  name: string,
  config?: ThemeConfig,
): void {
  fs.mkdirSync(dest, { recursive: true });
  if (!fs.existsSync(tpl)) {
    fs.writeFileSync(
      path.join(dest, "manifest.json"),
      JSON.stringify(
        {
          name,
          slug,
          description: "",
          version: "1.0.0",
          author: "",
          isDefault: false,
          config: config ?? {},
        },
        null,
        2,
      ),
    );
    return;
  }
  for (const entry of fs.readdirSync(tpl, { withFileTypes: true })) {
    const s = path.join(tpl, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else if (entry.name === "manifest.json") {
      const manifest = JSON.parse(fs.readFileSync(s, "utf-8"));
      manifest.name = name;
      manifest.slug = slug;
      manifest.isDefault = false;
      if (config && Object.keys(config).length) manifest.config = config;
      fs.writeFileSync(d, JSON.stringify(manifest, null, 2));
    } else if (entry.name === "index.ts" || entry.name === "index.tsx") {
      fs.writeFileSync(
        d,
        fs.readFileSync(s, "utf-8").replace(/oboext-2026|themes\/default/g, slug),
      );
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

/**
 * Create a theme: a REAL folder under themes/<slug>, never a phantom
 * DB-only row (that used to leave a "theme" lingering after folder delete).
 */
export async function createTheme(input: ThemeInput): Promise<Theme> {
  const name = (input.name ?? "").trim();
  if (!name) throw new ServiceError("请输入主题名称", 422);
  const slug = input.slug?.trim() || slugifyName(name);
  if (!/^[a-z0-9一-龥][a-z0-9一-龥-]*$/i.test(slug)) {
    throw new ServiceError("主题标识只能包含字母、数字、中划线与中文", 422);
  }
  const dir = path.join(THEMES_DIR, slug);
  if (fs.existsSync(dir)) throw new ServiceError("主题文件夹已存在", 422);
  const [exists] = await db.select({ id: themes.id }).from(themes).where(eq(themes.slug, slug));
  if (exists) throw new ServiceError("主题标识已存在", 422);

  copyThemeTemplate(path.join(THEMES_DIR, "default"), dir, slug, name, input.config);

  invalidateThemeDiscovery();
  await syncThemes();
  synced = true;
  const [row] = await db.select().from(themes).where(eq(themes.slug, slug));
  if (!row) throw new ServiceError("主题已落盘但同步失败，请检查 manifest.json", 500);
  return row;
}

export async function installThemeZip(buf: Buffer): Promise<Theme> {
  await ensureThemes();
  const info = installPackage("theme", buf);
  invalidateThemeDiscovery();
  await syncThemes();
  synced = true;
  const [row] = await db.select().from(themes).where(eq(themes.slug, info.slug));
  if (!row) throw new ServiceError("主题已落盘但同步失败，请检查 manifest.json", 500);
  return row;
}

export async function updateTheme(id: number, input: Partial<ThemeInput>): Promise<Theme> {
  const existing = await getThemeById(id);
  const slug = input.slug?.trim() || existing.slug;
  if (slug !== existing.slug) {
    const [exists] = await db.select({ id: themes.id }).from(themes).where(eq(themes.slug, slug));
    if (exists) throw new ServiceError("主题标识已存在", 422);
  }
  const [row] = await db
    .update(themes)
    .set({
      name: input.name ?? existing.name,
      slug,
      config: { ...existing.config, ...(input.config ?? {}) },
      settings: input.settings
        ? { ...existing.settings, ...input.settings }
        : existing.settings,
    })
    .where(eq(themes.id, id))
    .returning();
  // Cheap and unconditional: updateTheme is a rare admin write, and if it
  // touched the active theme the memoized row (config/settings) must go.
  invalidateActiveThemeCache();
  return row;
}

/**
 * Recursive rm + Windows backoff lives in fs-utils.ts (shared with the zip
 * installer): freshly written theme files can be briefly held by AV/indexer,
 * making rmSync throw EBUSY/EPERM/ENOTEMPTY. Those are transient.
 */
export async function deleteTheme(id: number): Promise<{ id: number }> {
  const existing = await getThemeById(id);

  // Never leave the site without an active theme: switch first if active.
  const [settings] = await db
    .select({ activeThemeSlug: siteSettings.activeThemeSlug })
    .from(siteSettings)
    .where(eq(siteSettings.id, 1));
  if (settings?.activeThemeSlug === existing.slug) {
    const others = discoverThemes().filter((t) => t.slug !== existing.slug);
    const fallback = others.find((t) => t.isDefault) ?? others[0] ?? null;
    if (fallback) {
      await db
        .update(siteSettings)
        .set({ activeThemeSlug: fallback.slug })
        .where(eq(siteSettings.id, 1));
    }
  }

  const dir = path.join(THEMES_DIR, existing.slug);
  if (fs.existsSync(dir)) rmSyncRetry(dir);
  invalidateThemeDiscovery();
  invalidateActiveThemeCache();
  await db.delete(themes).where(eq(themes.id, id));
  synced = false;
  return { id };
}

/** Mark a theme as the public-site active theme. */
export async function setActiveTheme(id: number): Promise<Theme> {
  const theme = await getThemeById(id);
  if (!PORTED_PUBLIC_THEMES.has(theme.slug)) {
    throw new ServiceError("该主题的前台模板尚未适配，暂不能启用", 422);
  }
  await db
    .update(siteSettings)
    .set({ activeThemeSlug: theme.slug, updatedAt: new Date() })
    .where(eq(siteSettings.id, 1));
  invalidateThemeDiscovery();
  invalidateActiveThemeCache();
  return theme;
}

// ------------------------------------------------------------ settings panel

export type ThemePanel = {
  theme: Theme;
  meta: ThemeMeta | null;
  /** Appearance sections — identical for every theme. */
  appearanceSchema: SettingsSchema;
  /** The theme's own sections, declared in manifest.json. */
  settingsSchema: SettingsSchema;
  widgetAreas: ThemeWidgetArea[];
  /** Resolved appearance values (factory → manifest → saved). */
  config: Record<string, unknown>;
  /** Factory + manifest baseline (panel preview layers palettes over it). */
  baselineConfig: Record<string, unknown>;
  /** Resolved theme-specific values (schema defaults → saved). */
  settings: Record<string, unknown>;
  isActive: boolean;
  hasManifest: boolean;
  /** Palette token tables for the panel's live preview. */
  palettes: Record<string, unknown>;
  /** Currently selected palette key (raw settings value), null when unset. */
  palette: string | null;
};

/** Resolve by numeric id or slug — admin routes accept both. */
async function resolveTheme(idOrSlug: string | number): Promise<Theme> {
  const asNumber = Number(idOrSlug);
  if (Number.isInteger(asNumber) && String(idOrSlug).trim() !== "") {
    const [byId] = await db.select().from(themes).where(eq(themes.id, asNumber));
    if (byId) return byId;
  }
  const [bySlug] = await db
    .select()
    .from(themes)
    .where(eq(themes.slug, String(idOrSlug)));
  if (!bySlug) throw new ServiceError("主题不存在", 404);
  return bySlug;
}

/** Everything /admin/themes/[slug] needs in one call. */
export async function getThemePanel(idOrSlug: string | number): Promise<ThemePanel> {
  const theme = await resolveTheme(idOrSlug);
  const manifest = getThemeManifest(theme.slug);
  const schema = getThemeSettingsSchema(theme.slug);

  const baseConfig = { ...DEFAULT_THEME_CONFIG, ...(manifest?.config ?? {}) };
  const config = resolveThemeConfig({ ...baseConfig, ...theme.config });

  const [settings] = await db
    .select({ activeThemeSlug: siteSettings.activeThemeSlug })
    .from(siteSettings)
    .where(eq(siteSettings.id, 1));

  return {
    theme,
    meta: getThemeMeta(theme.slug),
    appearanceSchema: THEME_CONFIG_SCHEMA,
    settingsSchema: schema,
    widgetAreas: getThemeWidgetAreas(theme.slug),
    config: config as unknown as Record<string, unknown>,
    baselineConfig: baseConfig as unknown as Record<string, unknown>,
    settings: resolveSettings(schema, theme.settings),
    isActive: settings?.activeThemeSlug === theme.slug,
    hasManifest: !!manifest,
    palettes: Object.fromEntries(PALETTE_PRESETS.map((p) => [p.key, p.tokens])),
    palette: (() => {
      const raw = (theme.settings as Record<string, unknown> | null)?.palette;
      return typeof raw === "string" && raw ? raw : null;
    })(),
  };
}

/**
 * Save a mixed panel payload. Appearance keys land in themes.config (CSS
 * tokens); the rest is coerced against the theme's own schema into
 * themes.settings. Unknown keys are dropped.
 *
 * A colour token equal to ANY free baseline (factory default, manifest
 * config, previous or newly selected palette) is not persisted, so the first
 * save doesn't pin factory colours and block later palette switches.
 */
export async function updateThemePanel(
  idOrSlug: string | number,
  payload: Record<string, unknown>,
): Promise<Theme> {
  const theme = await resolveTheme(idOrSlug);
  const configKeys = new Set(THEME_CONFIG_KEYS);
  const schema = getThemeSettingsSchema(theme.slug);

  // palette is a generic panel key, not declared in per-theme settings
  // schemas — resolveSettings() would strip it, so read the raw value.
  const previousRaw = (theme.settings as Record<string, unknown> | null)?.palette;
  const previousPalette =
    typeof previousRaw === "string" && previousRaw ? previousRaw : null;
  const nextRaw = payload.palette;
  const nextPalette =
    typeof nextRaw === "string" && nextRaw ? nextRaw : previousPalette;

  const incoming: Record<string, string> = {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (configKeys.has(k)) incoming[k] = v == null ? "" : String(v);
    else rest[k] = v;
  }

  const freeSources: Record<string, unknown>[] = [
    DEFAULT_THEME_CONFIG,
    getThemeManifest(theme.slug)?.config ?? {},
    getPalettePreset(previousPalette)?.tokens ?? {},
    getPalettePreset(nextPalette)?.tokens ?? {},
  ];
  const isFree = (k: string, v: string) =>
    freeSources.some((src) => typeof src[k] === "string" && String(src[k]).trim() === v);

  const submitted: Record<string, unknown> = { ...theme.config };
  for (const [k, v] of Object.entries(incoming)) submitted[k] = v;

  const config: Record<string, string> = {};
  for (const [k, v] of Object.entries(submitted)) {
    const s = String(v ?? "").trim();
    if (!s || isFree(k, s)) continue;
    config[k] = s;
  }

  const settingsPatch = coerceSettings(schema, rest);
  // Same reason as above: keep a recognised palette across saves even though
  // no per-theme schema declares it.
  if (nextPalette && getPalettePreset(nextPalette)) settingsPatch.palette = nextPalette;

  const [row] = await db
    .update(themes)
    .set({
      config: config as ThemeConfig,
      settings: { ...theme.settings, ...settingsPatch },
    })
    .where(eq(themes.id, theme.id))
    .returning();
  invalidateActiveThemeCache();
  return row;
}

/** Reset to manifest values (factory for hand-created themes), clear settings. */
export async function resetThemePanel(idOrSlug: string | number): Promise<Theme> {
  const theme = await resolveTheme(idOrSlug);
  const manifest = getThemeManifest(theme.slug);
  const [row] = await db
    .update(themes)
    .set({
      config: (manifest?.config ?? {}) as ThemeConfig,
      settings: {},
    })
    .where(eq(themes.id, theme.id))
    .returning();
  invalidateActiveThemeCache();
  return row;
}

/** The active theme's resolved own settings (hero copy, toggles, …). */
export async function getActiveThemeSettings(): Promise<Record<string, unknown>> {
  const theme = await getActiveTheme();
  return resolveSettings(getThemeSettingsSchema(theme.slug), theme.settings);
}

/** A specific (non-active) theme's resolved settings. */
export async function getThemeSettings(slug: string): Promise<Record<string, unknown>> {
  const theme = await getThemeBySlug(slug);
  if (!theme) return {};
  return resolveSettings(getThemeSettingsSchema(slug), theme.settings);
}

export async function getActiveThemeRenderConfig(): Promise<ThemeConfig> {
  const theme = await getActiveTheme();
  const manifest = getThemeManifest(theme.slug);
  // Raw read: palette is a generic panel key absent from theme settings schemas.
  const rawPalette = (theme.settings as Record<string, unknown> | null)?.palette;
  return paletteLayeredConfig(
    theme.config,
    { ...DEFAULT_THEME_CONFIG, ...(manifest?.config ?? {}) },
    typeof rawPalette === "string" ? rawPalette : undefined,
  );
}
