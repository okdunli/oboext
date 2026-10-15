// Theme chrome registry.
//
// A theme's renderer ships INSIDE the theme's own folder
// (themes/<slug>/chrome.ts) and is wired up by a generated entry table
// (theme-entries.ts, written by tools/gen.mjs). The program knows no theme by
// name: it asks the registry for the active slug and gets back whatever that
// folder exported. Sharing the program's render helpers happens through
// ./theme-api.js, which this module re-exports for existing callers.
export * from "./theme-api.js";

import { THEME_ENTRIES } from "./theme-entries.js";
import { defaultThemeSlug } from "./theme-api.js";
import type { ThemeChrome } from "./theme-api.js";

export function getThemeChrome(slug: string): ThemeChrome {
  const hit = THEME_ENTRIES[slug];
  if (hit) return hit;
  // Fallback: the manifest's own `isDefault` theme, then whatever exists. The
  // program still names no theme — the marker is a folder-level declaration.
  const dflt = defaultThemeSlug();
  if (dflt && THEME_ENTRIES[dflt]) return THEME_ENTRIES[dflt];
  const first = Object.values(THEME_ENTRIES)[0];
  if (first) return first;
  throw new Error("no theme chrome modules found under themes/*/chrome.ts");
}
