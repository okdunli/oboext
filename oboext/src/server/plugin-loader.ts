// Plugin loader — port of oboext lib/plugins/loader.ts.
import { removeAllByOwner, withOwner } from "./hooks.js";
import { createContext, type PluginDefinition } from "./plugin-api.js";
import { invalidatePluginDiscovery, pluginHasEntry } from "./plugin-registry.js";
import { PLUGIN_ENTRIES } from "./plugin-entries.js";
import { createLogger } from "./logger.js";
const log = createLogger("plugin-loader");

type LoadedState = {
  /** slug -> definition, for teardown */
  loaded: Map<string, PluginDefinition<any>>;
  /** in-flight init so concurrent requests coalesce */
  promise: Promise<void> | null;
  /** signature of the last enabled-set we applied */
  signature: string;
};

const g = globalThis as unknown as { __oboePlugins?: LoadedState };

function state(): LoadedState {
  if (!g.__oboePlugins) {
    g.__oboePlugins = { loaded: new Map(), promise: null, signature: "" };
  }
  return g.__oboePlugins;
}

export type EnabledPlugin = { slug: string; settings: Record<string, unknown> };

// Load (or reload) the given set of enabled plugins.
export async function loadPlugins(enabled: EnabledPlugin[]): Promise<void> {
  const s = state();
  const signature = enabled
    .map((p) => `${p.slug}:${JSON.stringify(p.settings)}`)
    .sort()
    .join("|");
  if (s.signature === signature && !s.promise) return;
  if (s.promise) return s.promise;

  s.promise = (async () => {
    const wanted = new Set(enabled.map((p) => p.slug));

    // Unload plugins that are no longer enabled (or whose settings changed).
    for (const [slug, def] of s.loaded) {
      if (wanted.has(slug) && s.signature === signature) continue;
      try {
        await def.teardown?.(createContext(slug, {}));
      } catch (err) {
        log.error(`[plugins] teardown of "${slug}" failed:`, err);
      }
      removeAllByOwner(slug);
      s.loaded.delete(slug);
    }

    for (const { slug, settings } of enabled) {
      if (!pluginHasEntry(slug)) {
        log.warn(`[plugins] "${slug}" is enabled but has no entry file — skipped.`);
        continue;
      }
      const entry = PLUGIN_ENTRIES[slug];
      if (!entry) {
        log.warn(
          `[plugins] "${slug}" is not in the build-time entry table ` +
            "(installed after the last build?) — run a rebuild, skipped.",
        );
        continue;
      }
      try {
        const mod = await entry();
        const def: PluginDefinition<any> | undefined = mod.default ?? mod.plugin;
        if (def?.setup) {
          const ctx = createContext(slug, settings);
          await withOwner(slug, () => def.setup(ctx));
          s.loaded.set(slug, def);
        } else {
          // Top-level side-effect style.
          s.loaded.set(slug, { setup: () => {} });
        }
      } catch (err) {
        log.error(`[plugins] failed to load "${slug}":`, err);
      }
    }

    s.signature = signature;
  })().finally(() => {
    s.promise = null;
  });

  return s.promise;
}

/** Slugs currently loaded in this process. */
export function loadedPluginSlugs(): string[] {
  return [...state().loaded.keys()];
}

/**
 * Force the next loadPlugins() call to re-run (used after toggling in admin).
 *
 * Also drops the registry's discovery memo. The two caches answer different
 * questions — "which plugin modules are imported" versus "which folders exist
 * on disk" — so a caller that invalidates one after writing a plugin folder
 * must invalidate both, or `discoverPlugins()` keeps serving the pre-install
 * manifest list until the directory mtime happens to change.
 */
export function invalidatePluginCache(): void {
  state().signature = "";
  invalidatePluginDiscovery();
}
