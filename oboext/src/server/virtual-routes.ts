import { applyAsyncFilters, HOOKS } from "./hooks.js";
import { ensurePluginsLoaded } from "./plugins.js";
import { DEFAULT_LOCALE, type Locale } from "./i18n.js";

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

  /** R531: the request locale, so a plugin route can answer in its language. */
  locale: Locale;
};

export async function resolveVirtualRoute(
  segments: string[],
  locale: Locale = DEFAULT_LOCALE,
): Promise<VirtualSiteRoute | null> {
  await ensurePluginsLoaded();
  const out = await applyAsyncFilters<SiteRoutesPayload>(HOOKS.siteRoutes, {
    segments,
    locale,
    route: null,
  });
  return out.route;
}
