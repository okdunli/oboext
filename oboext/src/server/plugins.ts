/**
 * Plugin service — port of oboext lib/services/plugins.ts.
 *
 * Syncs plugins/ on disk into the `plugins` table (new folders are inserted
 * DISABLED — third-party code is never auto-executed), serves the admin list,
 * and makes sure every enabled plugin is imported and registered before a
 * request renders content. Differences from the original app: no
 * ensureBootstrap (ensureMigrations covers it) and no public-cache bump (this
 * app renders per request with no cross-response cache).
 */
import { asc, eq, sql } from "drizzle-orm";
import { db, ensureMigrations } from "./db.js";
import { plugins, type Plugin } from "./schema.js";
import {
  discoverPlugins,
  getPluginManifest,
  pluginHasAdmin,
  pluginHasEntry,
  type PluginManifest,
} from "./plugin-registry.js";
import { invalidatePluginCache, loadPlugins } from "./plugin-loader.js";
import { coerceSettings, resolveSettings } from "./settings-schema.js";
import { ServiceError } from "./admin.js";
import { installPackage } from "./package-install.js";
import { PLUGIN_ENTRIES } from "./plugin-entries.js";

export type PluginView = Plugin & {
  manifest: PluginManifest | null;
  /** Present on disk? A row can outlive a deleted folder. */
  installed: boolean;
  hasEntry: boolean;
  /** Ships a custom admin page at plugins/<slug>/admin.tsx. */
  hasAdmin: boolean;
  /** defaults merged with stored values */
  resolvedSettings: Record<string, unknown>;
  /** present in the build-time static entry table (else needs a rebuild) */
  runnable: boolean;
};

/**
 * Sync plugins/ on disk into the `plugins` table. New folders are inserted
 * disabled by default; metadata is refreshed. Rows whose folder disappeared
 * simply match no manifest on read (kept so settings survive a temporary move).
 */
export async function syncPlugins(): Promise<void> {
  await ensureMigrations();
  const manifests = discoverPlugins();
  if (manifests.length === 0) return;
  await db
    .insert(plugins)
    .values(
      manifests.map((m) => ({
        slug: m.slug,
        name: m.name,
        description: m.description ?? "",
        version: m.version ?? "1.0.0",
        author: m.author ?? "",
        enabled: false,
        settings: {},
      })),
    )
    .onConflictDoUpdate({
      target: plugins.slug,
      set: {
        name: sql`excluded."name"`,
        description: sql`excluded."description"`,
        version: sql`excluded."version"`,
        author: sql`excluded."author"`,
      },
    });
}

/**
 * Install a plugin from an uploaded zip: validate plugin.json + entry, land
 * it under plugins/<slug>, sync the row (disabled by default). A newly
 * installed plugin only executes after the next build regenerates the static
 * entry table — see plugin-entries.ts.
 */
export async function installPluginZip(buf: Buffer): Promise<PluginView> {
  await ensureMigrations();
  const info = installPackage("plugin", buf);
  invalidatePluginCache();
  await syncPlugins();
  try {
    return await getPlugin(info.slug);
  } catch {
    throw new ServiceError("插件已落盘但同步失败，请检查 plugin.json", 400);
  }
}

export async function listPlugins(): Promise<PluginView[]> {
  await ensureMigrations();
  const rows = await db.select().from(plugins).orderBy(asc(plugins.slug));
  return rows.map((row: Plugin) => {
    const manifest = getPluginManifest(row.slug);
    return {
      ...row,
      manifest,
      installed: !!manifest,
      hasEntry: !!manifest && pluginHasEntry(row.slug),
      hasAdmin: !!manifest && pluginHasAdmin(row.slug),
      resolvedSettings: resolveSettings(manifest?.settings ?? [], row.settings),
      runnable: Object.prototype.hasOwnProperty.call(PLUGIN_ENTRIES, row.slug),
    };
  });
}

export async function getPlugin(slug: string): Promise<PluginView> {
  const all = await listPlugins();
  const found = all.find((p) => p.slug === slug);
  if (!found) throw new ServiceError("插件不存在", 404);
  return found;
}

export async function setPluginEnabled(
  slug: string,
  enabled: boolean,
): Promise<PluginView> {
  await ensureMigrations();
  const [row] = await db
    .update(plugins)
    .set({ enabled })
    .where(eq(plugins.slug, slug))
    .returning();
  if (!row) throw new ServiceError("插件不存在", 404);
  invalidatePluginCache();
  pluginsReady = false;
  await ensurePluginsLoaded();
  return getPlugin(slug);
}

export async function updatePluginSettings(
  slug: string,
  payload: Record<string, unknown>,
): Promise<PluginView> {
  await ensureMigrations();
  const manifest = getPluginManifest(slug);
  const clean = coerceSettings(manifest?.settings ?? [], payload);
  const [existing] = await db.select().from(plugins).where(eq(plugins.slug, slug));
  if (!existing) throw new ServiceError("插件不存在", 404);
  await db
    .update(plugins)
    .set({ settings: { ...existing.settings, ...clean } })
    .where(eq(plugins.slug, slug));
  invalidatePluginCache();
  pluginsReady = false;
  await ensurePluginsLoaded();
  return getPlugin(slug);
}

/**
 * Ensure every enabled plugin has been imported and had its hooks registered.
 * Call at the top of any request path that renders content or fires hooks.
 * Warm requests short-circuit on a process flag; cold concurrent requests
 * coalesce onto one in-flight promise.
 */
let pluginsReady = false;
let pluginsInflight: Promise<void> | null = null;

export function ensurePluginsLoaded(): Promise<void> {
  if (pluginsReady) return Promise.resolve();
  if (pluginsInflight) return pluginsInflight;
  pluginsInflight = (async () => {
    await ensureMigrations();
    const rows = await db
      .select({ slug: plugins.slug, settings: plugins.settings, enabled: plugins.enabled })
      .from(plugins)
      .where(eq(plugins.enabled, true))
      .orderBy(asc(plugins.slug));
    const manifests = new Map(discoverPlugins().map((m) => [m.slug, m]));
    const enabled = rows
      .filter((r: { slug: string }) => manifests.has(r.slug))
      .map((r: { slug: string; settings: Record<string, unknown> }) => ({
        slug: r.slug,
        settings: resolveSettings(manifests.get(r.slug)?.settings ?? [], r.settings),
      }));
    await loadPlugins(enabled);
    pluginsReady = true;
  })().finally(() => {
    pluginsInflight = null;
  });
  return pluginsInflight;
}

/**
 * Drop plugin caches and immediately reload. For whole-DB restores and
 * similar paths that bypass the normal mutating services.
 */
export async function reloadPlugins(): Promise<void> {
  invalidatePluginCache();
  pluginsReady = false;
  await ensurePluginsLoaded();
}
