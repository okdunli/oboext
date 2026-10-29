// The public surface a plugin is handed at setup time (ported from Oboext lib/plugins/api.ts).
import {
  addAction,
  addFilter,
  applyFilters,
  doAction,
  HOOKS,
  type HookCallback,
} from "./hooks.js";
import { createLogger } from "./logger.js";
const log = createLogger("plugin-api");

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
    log: (msg: string, ...args: unknown[]) => log.child(slug).info(msg, ...args),
  };
}
