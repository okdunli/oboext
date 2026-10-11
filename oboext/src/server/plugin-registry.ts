/**
 * Plugin discovery (ported from oboext lib/plugins/registry.ts).
 * A plugin is any `plugins/<slug>/` directory holding a `plugin.json`.
 * Nothing is imported here — discovery stays cheap and side-effect free so
 * the admin can list disabled plugins too.
 */
import fs from "node:fs";
import path from "node:path";
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

export function discoverPlugins(): PluginManifest[] {
  const found: PluginManifest[] = [];
  if (!fs.existsSync(PLUGINS_DIR)) return found;

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
  return found.sort((a, b) => a.slug.localeCompare(b.slug));
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
 * Does the plugin ship a custom admin page? Convention:
 * `plugins/<slug>/admin.tsx`, hosted at /admin/plugins/<slug>.
 */
export function pluginHasAdmin(slug: string): boolean {
  const dir = path.join(PLUGINS_DIR, slug);
  return ["admin.tsx", "admin.jsx", "admin.js"].some((f) =>
    fs.existsSync(path.join(dir, f)),
  );
}
