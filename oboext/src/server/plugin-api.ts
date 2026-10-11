/**
 * The public surface a plugin is handed at setup time (ported from
 * oboext lib/plugins/api.ts). Plugins never touch the hook registry
 * directly — they receive a scoped API so every registration is attributed
 * to the owning slug (enabling clean unload) and settings arrive as a plain
 * object with defaults already merged.
 */
import {
  addAction,
  addFilter,
  applyFilters,
  doAction,
  HOOKS,
  type HookCallback,
} from "./hooks.js";

export interface PluginContext<S = Record<string, unknown>> {
  slug: string;
  settings: S;
  addAction: <P = any>(hook: string, cb: HookCallback<P>, priority?: number) => void;
  addFilter: <P = any>(hook: string, cb: HookCallback<P>, priority?: number) => void;
  doAction: typeof doAction;
  applyFilters: typeof applyFilters;
  /** Canonical core hook names. */
  HOOKS: typeof HOOKS;
  /** Structured logger prefixed with the plugin slug. */
  log: (...args: unknown[]) => void;
}

export interface PluginDefinition<S = Record<string, unknown>> {
  slug?: string;
  /** Called once when the plugin is enabled and loaded. */
  setup: (ctx: PluginContext<S>) => void | Promise<void>;
  /** Optional teardown, called when the plugin is disabled at runtime. */
  teardown?: (ctx: PluginContext<S>) => void | Promise<void>;
}

/** Declare a plugin. Kept thin — it only tags the object for the loader. */
export function definePlugin<S = Record<string, unknown>>(
  def: PluginDefinition<S>,
): PluginDefinition<S> {
  return def;
}

export function createContext<S = Record<string, unknown>>(
  slug: string,
  settings: S,
): PluginContext<S> {
  return {
    slug,
    settings,
    addAction,
    addFilter,
    doAction,
    applyFilters,
    HOOKS,
    log: (...args: unknown[]) => console.log(`[plugin:${slug}]`, ...args),
  };
}
