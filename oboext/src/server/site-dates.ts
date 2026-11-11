// The site's own date context.
//
// A blog has ONE calendar: the timezone the site is configured for and the
// date format the site owner picked. Every visitor-facing date must agree
// with it - a post published at 20:00 UTC belongs to the NEXT day in
// Asia/Shanghai, and the site already SHOWS that day (the admin list, the
// sitemap's lastmod, the visit-source buckets all use the site's timezone).
//
// The front desk used to disagree: its date helpers read the SERVER's clock
// fields, so the same post showed one date on the front desk and another in
// the admin list, and the site's `dateFormat` setting had no effect there at
// all.
//
// The context is site-wide configuration, not per-request state, so a single
// module-level copy is the honest model: every settings read refreshes it
// (queries.getSettings), and the render helpers read it synchronously. The
// fallback is the app's default site timezone, so a render that happens
// before the first settings read still shows a plausible date instead of
// throwing.

export type SiteDateContext = {
  /** The site's IANA timezone - the calendar every day label belongs to. */
  timezone: string;
  /** The site's date format: YYYY-MM-DD | YYYY年M月D日 | MMM D, YYYY | D/M/YYYY */
  dateFormat: string;
  /** The site's UI language, when set. */
  language?: string;
};

const FALLBACK: SiteDateContext = {
  timezone: "Asia/Shanghai",
  dateFormat: "YYYY-MM-DD",
};

let current: SiteDateContext = FALLBACK;

/** The site's current date context. */
export function siteDateContext(): SiteDateContext {
  return current;
}

/**
 * Refresh the context from a settings row.
 *
 * Called from queries.getSettings() - the one place the site settings are
 * read - so the context is always in step with the settings the rest of the
 * app is using, without threading a settings object through every render
 * helper (and without breaking the theme API's call sites).
 */
export function updateSiteDateContext(
  settings: Record<string, unknown> | null | undefined,
): void {
  if (!settings) return;
  const tz = String(settings.timezone ?? "");
  const df = String(settings.dateFormat ?? "");
  current = {
    timezone: tz || FALLBACK.timezone,
    dateFormat: df || FALLBACK.dateFormat,
    language: typeof settings.language === "string" ? settings.language : undefined,
  };
}

/**
 * The numeric Y-M-D parts of an instant, in a timezone.
 *
 * The formatter is cached per zone: building an Intl.DateTimeFormat costs
 * ~70µs and these run once per rendered date (see the comment in render.ts).
 */
const NUMERIC_FMT = new Map<string, Intl.DateTimeFormat>();

export function siteNumericFmt(tz: string): Intl.DateTimeFormat {
  let f = NUMERIC_FMT.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
    } catch {
      f = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
    }
    NUMERIC_FMT.set(tz, f);
  }
  return f;
}

/**
 * The calendar YEAR the site is in right now.
 *
 * The footer's copyright year used to come from the server's clock, so in the
 * last hour of New Year's Eve the footer could name a year the site had not
 * started yet (or had already left).
 */
export function siteYear(now: Date = new Date()): number {
  const [y] = siteNumericFmt(siteDateContext().timezone).format(now).split("-");
  return Number(y);
}

/**
 * The Y/M/D day-parts of an instant, in the given timezone.
 *
 * `month`/`day` arrive zero-padded (en-CA emits two-digit parts), matching
 * what a URL token and a bucket key both want.
 */
export function siteDayParts(
  d: Date,
  tz: string,
): { year: string; month: string; day: string } {
  const [year, month, day] = siteNumericFmt(tz).format(d).split("-");
  return { year, month, day };
}
