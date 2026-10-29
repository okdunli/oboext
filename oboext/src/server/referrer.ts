// Referrer provenance for visitor counting (db/migrations/0041).
//
// The dashboard question is "where does the traffic come from", and the only
// honest answer a server can give without cookies or scripts is the Referer
// header of the landing request. Two rules shape everything here:
//
//   1. HOST ONLY reaches the database. A full referrer URL can carry a search
//      query ("?q=someone's medical question"), a session token, or an email
//      address. The host already answers the question, so that is all that is
//      stored - the URL is parsed and thrown away.
//   2. Classification never throws. This runs on the page-view path, where a
//      malformed header from a scanner must cost exactly nothing. Anything that
//      cannot be parsed becomes "direct" (there is no usable source at all); a
//      parseable host that is not on either table becomes "other".
//
// The host tables match registrable domains as SUFFIXES, not on
// `host.includes("google")` - "notgoogle.com" and "google.com.evil.tld" are
// other people's domains and must not be credited to a search engine.

/** The classification vocabulary. Stored verbatim in visit_daily.referrer_kind. */
export const REFERRER_KINDS = ["search", "social", "internal", "direct", "other"] as const;
export type ReferrerKind = (typeof REFERRER_KINDS)[number];

/** Search engines, matched as a suffix of the (lowercased) host. */
const SEARCH_HOSTS = [
  "google.com",
  "googleusercontent.com",
  "bing.com",
  "msn.com",
  "baidu.com",
  "duckduckgo.com",
  "yandex.com",
  "yandex.ru",
  "ya.ru",
  "sogou.com",
  "so.com",
  "360.cn",
  "sm.cn",
  "ecosia.org",
  "brave.com",
  "qwant.com",
  "startpage.com",
  "search.yahoo.com",
  "naver.com",
  "seznam.cz",
];

/** Social networks and link aggregators, matched the same way. */
const SOCIAL_HOSTS = [
  "twitter.com",
  "x.com",
  "t.co",
  "facebook.com",
  "fb.com",
  "instagram.com",
  "threads.net",
  "t.me",
  "telegram.me",
  "weibo.com",
  "weibo.cn",
  "douyin.com",
  "tiktok.com",
  "zhihu.com",
  "reddit.com",
  "linkedin.com",
  "lnkd.in",
  "youtube.com",
  "youtu.be",
  "bilibili.com",
  "discord.com",
  "discord.gg",
  "mastodon.social",
  "ycombinator.com",
];

/** True when `host` is one of `suffixes` or a subdomain of one. */
function matchesHostSuffix(host: string, suffixes: string[]): boolean {
  for (const s of suffixes) {
    if (host === s || host.endsWith("." + s)) return true;
  }
  return false;
}

/**
 * Lowercase host of a URL-ish string, or "" when it cannot be parsed.
 *
 * Accepts the raw header value and tolerates the shapes a real site sees:
 * protocol-relative ("//example.com/x"), a bare host with no scheme (some
 * proxies strip it), a trailing dot, and surrounding whitespace. Never throws.
 */
export function referrerHostOf(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : "https://" + s.replace(/^\/+/, "");
  try {
    return new URL(withScheme).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

/**
 * Classify a referrer into the stored vocabulary.
 *
 * `siteHost` is the host of THIS site (the request's own host). A referrer on
 * it is an internal navigation - clicking from the home page to a post - and is
 * recorded as such rather than being credited to an external source. With an
 * empty `siteHost` (a synthetic request with no Host header, or a caller that
 * does not know its own host) the comparison is skipped: the worst case is an
 * internal hop counted as "other", never a parse failure.
 */
export function classifyReferrer(raw: unknown, siteHost = ""): ReferrerKind {
  const host = referrerHostOf(raw);
  if (!host) return "direct";
  const own = String(siteHost ?? "")
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "")
    .replace(/^www\./, "");
  if (own && (host === own || host.endsWith("." + own))) return "internal";
  if (matchesHostSuffix(host, SEARCH_HOSTS)) return "search";
  if (matchesHostSuffix(host, SOCIAL_HOSTS)) return "social";
  return "other";
}
