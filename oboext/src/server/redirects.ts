// R193: custom redirects — the rules that keep an old public URL alive after
// the thing behind it moved. See db/migrations/0031 for why the columns and
// the folded unique index look the way they do.
import { desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "./db.js";
import { redirects, type Redirect } from "./schema.js";
import { invalidate, memoStrict } from "./cache.js";
import { ServiceError } from "./errors.js";
import { createLogger } from "./logger.js";

const log = createLogger("redirects");

type Rule = { id: number; target: string; permanent: boolean };

/**
 * The whole table, folded into a Map, memoized.
 *
 * Matching happens on the request path that would otherwise 404, and bots
 * probe unknown paths constantly; `memoStrict` turns that into one small
 * sequential read per process per TTL instead of one per probe. A redirect
 * table is operator-authored and stays in the tens-to-hundreds of rows, so
 * loading it whole is cheaper than any per-probe query plan.
 */
const MAP_KEY = "rd:map";
const MAP_TTL = 30_000;

async function ruleMap(): Promise<Map<string, Rule>> {
  return memoStrict(MAP_KEY, MAP_TTL, async () => {
    const rows = await db
      .select({
        id: redirects.id,
        source: redirects.source,
        target: redirects.target,
        permanent: redirects.permanent,
      })
      .from(redirects)
      .orderBy(redirects.id);
    const m = new Map<string, Rule>();
    for (const r of rows) m.set(r.source.toLowerCase(), { id: r.id, target: r.target, permanent: r.permanent });
    return m;
  });
}

function decodePath(p: string): string {
  try {
    return decodeURIComponent(p);
  } catch {
    // A stray % that is not a valid escape: the raw path is what the visitor
    // actually asked for, so keep it instead of throwing on their behalf.
    return p;
  }
}

/** `/a//b/` and `/a/b` and `a/b` are one and the same URL; keep any query. */
function foldPath(raw: string): string {
  const q = raw.indexOf("?");
  const path = q === -1 ? raw : raw.slice(0, q);
  const query = q === -1 ? "" : raw.slice(q);
  const norm = "/" + path.split("/").filter((s) => s && s !== ".").join("/");
  return norm === "/" ? "/" : norm + query;
}

export function normalizeSource(raw: string): string {
  const v = (raw ?? "").trim();
  if (!v) throw new ServiceError("源路径不能为空", 400);
  if (v.startsWith("//")) throw new ServiceError("源路径必须是本站路径，不能是 //host 形式", 400);
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) throw new ServiceError("源路径必须是本站路径，不能带协议", 400);
  const folded = foldPath(decodePath(v.startsWith("/") ? v : `/${v}`));
  if (folded === "/") throw new ServiceError("首页不能作为重定向的源", 400);
  if (folded.length > 1000) throw new ServiceError("源路径过长", 400);
  return folded;
}

/**
 * A target is either an internal path or an absolute http(s) URL. Everything
 * else is refused, and the refusals are the point: `javascript:`/`data:` in a
 * Location header is how a redirect table becomes a script injector, and
 * `//host` looks exactly like a mistyped `/path` while being an off-site hop.
 */
export function normalizeTarget(raw: string, source: string): string {
  const v = (raw ?? "").trim();
  if (!v) throw new ServiceError("目标地址不能为空", 400);
  if (/^https?:\/\//i.test(v)) {
    if (v.length > 2000) throw new ServiceError("目标地址过长", 400);
    return v;
  }
  if (v.startsWith("//")) throw new ServiceError("目标不能是协议相对地址（//host）", 400);
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) throw new ServiceError("目标协议不受支持，只接受站内路径或 http(s)", 400);
  if (!v.startsWith("/")) throw new ServiceError("目标必须是站内路径（以 / 开头）或 http(s) 绝对地址", 400);
  const folded = foldPath(decodePath(v));
  if (folded.split("?")[0] === source) throw new ServiceError("不能把路径重定向到它自己", 400);
  return folded;
}

/**
 * A→B→A is a loop the browser reports as "too many redirects", and each half
 * looks perfectly reasonable on its own, so the check is a walk of the chain
 * the new rule would join. Capped: a longer chain than this is already a
 * misconfiguration, and the cap keeps a hand-built cycle from costing a loop.
 */
async function assertNoCycle(source: string, target: string): Promise<void> {
  if (!target.startsWith("/")) return;
  const m = await ruleMap();
  let cur = foldPath(target.split("?")[0]);
  for (let hops = 0; hops < 8; hops++) {
    const next = m.get(cur.toLowerCase());
    if (!next || !next.target.startsWith("/")) return;
    cur = foldPath(next.target.split("?")[0]);
    if (cur === source) throw new ServiceError("这条规则会与已有规则形成重定向环", 400);
  }
}

export async function listRedirects(limit = 200): Promise<Redirect[]> {
  return db.select().from(redirects).orderBy(desc(redirects.id)).limit(Math.min(Math.max(limit, 1), 500));
}

export async function createRedirect(
  input: { source: string; target: string; permanent?: boolean },
  auto = false,
): Promise<Redirect> {
  const source = normalizeSource(String(input.source ?? ""));
  const target = normalizeTarget(String(input.target ?? ""), source);
  await assertNoCycle(source, target);
  const clash = await db
    .select({ id: redirects.id })
    .from(redirects)
    .where(sql`lower(${redirects.source}) = lower(${source})`)
    .limit(1);
  if (clash.length) throw new ServiceError(`源路径已存在规则（#${clash[0].id}）`, 409);
  const [row] = await db
    .insert(redirects)
    .values({ source, target, permanent: input.permanent !== false, auto })
    .returning();
  invalidate(MAP_KEY);
  return row;
}

export async function deleteRedirects(ids: number[]): Promise<{ affected: number }> {
  const clean = ids.filter((n) => Number.isInteger(n) && n > 0).slice(0, 500);
  if (!clean.length) throw new ServiceError("无效的重定向规则 id", 400);
  const out = await db
    .delete(redirects)
    .where(inArray(redirects.id, clean))
    .returning({ id: redirects.id });
  if (out.length) invalidate(MAP_KEY);
  return { affected: out.length };
}

/**
 * A rename happened: keep the old URL alive by pointing it at the new one.
 *
 * Called from the content-write path, so it must never be the reason a save
 * fails — every problem is logged and swallowed. An existing rule wins and is
 * left alone: if the operator already wrote one for that old path (or an
 * earlier rename claimed it), overwriting their target would silently undo a
 * decision they made.
 */
export async function captureRename(from: string, to: string): Promise<boolean> {
  try {
    const source = foldPath(from);
    const target = foldPath(to);
    if (source === "/" || source === target) return false;
    const clash = await db
      .select({ id: redirects.id })
      .from(redirects)
      .where(sql`lower(${redirects.source}) = lower(${source})`)
      .limit(1);
    if (clash.length) return false;
    await db.insert(redirects).values({ source, target, permanent: true, auto: true });
    invalidate(MAP_KEY);
    return true;
  } catch (err) {
    log.warn("[redirects] rename capture failed:", err);
    return false;
  }
}

/**
 * The percent-encoded form is what the wire carries (`/blog/%E8%80%81`), the
 * decoded form is what the admin typed (`/blog/老`); one row has to answer
 * both, and the case fold matches the `lower(source)` unique index.
 */
export async function matchRedirect(path: string): Promise<Rule | null> {
  const m = await ruleMap();
  if (!m.size) return null;
  const folded = foldPath(path);
  const hit = m.get(folded.toLowerCase()) ?? m.get(foldPath(decodePath(path)).toLowerCase());
  return hit ?? null;
}

/**
 * `hits` is a triage number, not an audit trail: it is counted at most once a
 * minute per rule, so a redirect that a crawler hammeres reads as "hot"
 * without the table taking one UPDATE per request. Deliberately fire-and-
 * forget — a failed counter must not cost a visitor their redirect.
 */
const counted = new Map<number, number>();
const COUNT_THROTTLE = 60_000;

function countHit(id: number): void {
  const now = Date.now();
  const last = counted.get(id);
  if (last !== undefined && now - last < COUNT_THROTTLE) return;
  counted.set(id, now);
  if (counted.size > 512) counted.clear();
  void db
    .update(redirects)
    .set({ hits: sql`${redirects.hits} + 1`, updatedAt: new Date() })
    .where(eq(redirects.id, id))
    .catch((err) => log.warn("[redirects] hit counter failed:", err));
}

/**
 * The answer for the catch-all page: the href to send the visitor to and the
 * status to send it with, already locale-prefixed. Null means "no rule", which
 * is the caller's signal to 404 as it always did.
 */
export async function redirectFor(
  path: string,
  localeHref: (target: string) => string,
): Promise<{ href: string; status: 301 | 302 } | null> {
  const hit = await matchRedirect(path);
  if (!hit) return null;
  countHit(hit.id);
  return {
    href: hit.target.startsWith("/") ? localeHref(hit.target) : hit.target,
    status: hit.permanent ? 301 : 302,
  };
}
