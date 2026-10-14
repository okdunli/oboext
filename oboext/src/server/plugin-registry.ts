/**
 * Plugin discovery (ported from oboext lib/plugins/registry.ts).
 * A plugin is any `plugins/<slug>/` directory holding a `plugin.json`.
 * Nothing is imported here — discovery stays cheap and side-effect free so
 * the admin can list disabled plugins too.
 */
import fs from "fs";
import path from "path";
import type { SettingsSchema } from "./settings-schema.js";

export interface PluginManifest {
  slug: string;
  name: string;
  description?: string;
  version?: string;
  author?: string;
  /** Minimum core version required. */
  requires?: string;
  /** Author website; admin renders the author name as a link to it. */
  homepage?: string;
  /** Last-updated display string (YYYY-MM-DD); falls back to mtime. */
  updatedAt?: string;
  /** lucide icon name shown in the admin list. */
  icon?: string;
  /** Declarative settings form. */
  settings?: SettingsSchema;
  /** Hooks the plugin registers — informational, shown in the admin. */
  hooks?: string[];
}

const PLUGINS_DIR = path.join(process.cwd(), "plugins");

export { PLUGINS_DIR };

/**
 * Discovery result cache, keyed by the plugins directory's mtime.
 *
 * `getPluginManifest(slug)` used to call `discoverPlugins()` on every lookup,
 * so `listPlugins()` re-scanned the whole directory once per row — measured at
 * 45.7ms for 18 plugins versus 2.5ms for one scan plus a Map. Any admin page
 * listing plugins paid that on every render.
 *
 * The cache is keyed on the directory mtime rather than being permanent, so a
 * plugin folder appearing or disappearing (zip install, manual copy, delete)
 * is picked up without an explicit invalidation call — the next lookup stats
 * the directory (one syscall) and rescans only when it actually changed.
 */
let cached: { key: string; manifests: PluginManifest[] } | null = null;

function dirFingerprint(): string {
  try {
    const st = fs.statSync(PLUGINS_DIR);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "missing";
  }
}

export function discoverPlugins(): PluginManifest[] {
  const fp = dirFingerprint();
  if (cached && cached.key === fp) return cached.manifests;

  const found: PluginManifest[] = [];
  if (!fs.existsSync(PLUGINS_DIR)) {
    cached = { key: fp, manifests: found };
    return found;
  }

  for (const entry of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(PLUGINS_DIR, entry.name, "plugin.json");
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(
        fs.readFileSync(manifestPath, "utf-8"),
      ) as PluginManifest;
      manifest.slug = entry.name;
      if (!manifest.name) manifest.name = entry.name;
      if (!manifest.updatedAt) {
        try {
          manifest.updatedAt = fs.statSync(manifestPath).mtime.toISOString().slice(0, 10);
        } catch {
          // unreadable stat — leave blank
        }
      }
      found.push(manifest);
    } catch {
      // Ignore invalid manifests instead of taking the whole admin down.
    }
  }
  found.sort((a, b) => a.slug.localeCompare(b.slug));
  cached = { key: fp, manifests: found };
  return found;
}

/** Force the next discovery to re-scan (after install/uninstall). */
export function invalidatePluginDiscovery(): void {
  cached = null;
}

export function getPluginManifest(slug: string): PluginManifest | null {
  return discoverPlugins().find((p) => p.slug === slug) ?? null;
}

/** Does the plugin ship an entry file we can import? */
export function pluginHasEntry(slug: string): boolean {
  const dir = path.join(PLUGINS_DIR, slug);
  return ["index.ts", "index.tsx", "index.js", "index.mjs"].some((f) =>
    fs.existsSync(path.join(dir, f)),
  );
}

/**
 * Does the plugin ship a custom admin panel? rosezm idiom: the plugin's
 * index.ts fills the admin.panel filter and declares it in plugin.json's
 * `hooks`. The original's on-disk admin.tsx convention is NOT used by this
 * port (those files were removed once ported) — declarative settings live in
 * the manifest schema the generic settings modal renders; only a plugin with
 * a real custom panel declares admin.panel.
 */
export function pluginHasAdmin(slug: string): boolean {
  const manifest = getPluginManifest(slug);
  return !!manifest?.hooks?.includes("admin.panel");
}
