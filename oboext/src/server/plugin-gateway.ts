// Plugin HTTP gateway — port of Oboext lib/services/plugin-gateway.ts.
import { HOOKS, applyAsyncFilters } from "./hooks.js";
import { ensurePluginsLoaded, listPlugins } from "./plugins.js";

/** Plugin-authored HTTP response, JSON by default. */
export type PluginApiResponse = {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
};

export type PluginApiPayload = {
  /** Target plugin slug (URL segment after /api/plugin/). */
  slug: string;
  /** Remaining URL segments, e.g. ["ranking"] for /api/plugin/checkin/ranking. */
  path: string[];
  method: string;
  request: Request;
  response: PluginApiResponse | null;
};

export async function dispatchPluginApi(
  slug: string,
  path: string[],
  request: Request,
): Promise<PluginApiResponse | null> {
  await ensurePluginsLoaded();
  const enabled = (await listPlugins()).some(
    (p) => p.slug === slug && p.enabled && p.installed,
  );
  if (!enabled) return null;

  const out = await applyAsyncFilters<PluginApiPayload>(HOOKS.apiRequest, {
    slug,
    path,
    method: request.method.toUpperCase(),
    request,
    response: null,
  });
  return out.response;
}
