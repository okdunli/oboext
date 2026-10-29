import { applyAsyncFilters, HOOKS } from "./hooks.js";
import { ensurePluginsLoaded } from "./plugins.js";

export type VirtualSiteRoute = {

  title: string;

  html: string;

  path: string;
  seoTitle?: string;
  seoDescription?: string;
  seoKeywords?: string;
};

export type SiteRoutesPayload = {

  segments: string[];

  route: VirtualSiteRoute | null;
};

export async function resolveVirtualRoute(
  segments: string[],
): Promise<VirtualSiteRoute | null> {
  await ensurePluginsLoaded();
  const out = await applyAsyncFilters<SiteRoutesPayload>(HOOKS.siteRoutes, {
    segments,
    route: null,
  });
  return out.route;
}
