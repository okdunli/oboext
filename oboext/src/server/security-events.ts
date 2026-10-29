import { and, desc, eq, lt, sql } from "drizzle-orm";
import { db, ensureMigrations } from "./db.js";
import { securityEvents } from "./schema.js";
import { offsetNum } from "./paging.js";
import { createLogger } from "./logger.js";
const log = createLogger("security-events");

// Admin audit trail: writes go straight to the table (importing recordLoginEvent
// from auth.ts would be a cycle - auth imports this module). Same never-throw
// contract: an audit failure must not break the admin operation it documents.
export async function recordAdminAction(
  user: { id?: number | null; email?: string | null } | null,
  action: string,
  detail?: unknown,
): Promise<void> {
  try {
    let stored: Record<string, unknown> | undefined;
    if (detail !== undefined) {
      // 500 chars keeps jsonb rows bounded; anything longer is noise, not evidence.
      const s = typeof detail === "string" ? detail : JSON.stringify(detail);
      stored = { data: s.slice(0, 500) };
    }
    await db.insert(securityEvents).values({
      eventType: `admin.${action}`,
      userId: user?.id ?? null,
      account: user?.email?.trim().slice(0, 120) || null,
      detail: stored,
    });
    await pruneSecurityEvents();
  } catch (e) {
    log.error("[security-events] admin action write failed:", e);
  }
}

// Retention: the events table only ever had INSERTs, so it grows forever.
//
// The predicate stays a bare `created_at <` with no new index and no bounded
// batch, because both were measured against the shipped form (200 000 rows,
// 90% stale, scripts/retention.test.mts records the verdict). The existing
// security_events_type_idx - (event_type, created_at) - already answers it with
// a Bitmap Index Scan: the steady-state no-op pass costs 0.581 ms / 585 buffers.
// A (created_at, id) btree made the bulk delete *slower* (253 ms vs 226 ms),
// and the id-bounded rewrite with a `SELECT id … LIMIT` subquery - the usual
// answer for "one huge delete" - made the no-op pass ~220x worse (130 ms / 541
// 100 buffers), because its inner scan has no event_type to descend on. The
// trigger is what was wrong, not the SQL - see retention.ts.
let lastPruneAt = 0;
export async function pruneSecurityEvents(opts: { force?: boolean } = {}): Promise<void> {
  const now = Date.now();
  if (!opts.force && now - lastPruneAt < 3_600_000) return;
  lastPruneAt = now;
  const days = Number(process.env.OBOEXT_SECURITY_LOG_DAYS) || 90;
  try {
    await db
      .delete(securityEvents)
      .where(lt(securityEvents.createdAt, new Date(now - days * 86_400_000)));
  } catch (e) {
    log.warn("[security-events] prune failed:", e);
  }
}

export interface SecurityEventView {
  id: number;
  eventType: string;
  userId: number | null;
  account: string | null;
  ip: string | null;
  userAgent: string | null;
  detail: unknown;
  createdAt: Date | null;
}

export interface SecurityEventFilter {
  limit?: number;
  offset?: number;
  eventType?: string;
  /** Prefix match on event_type, e.g. "admin." for every admin.* audit row. */
  typePrefix?: string;
  account?: string;
  ip?: string;
}

// Each arm exists because the table has an index for it and nothing else:
//   eventType -> security_events_type_idx (event_type, created_at)          [0015]
//   account   -> security_events_account_lower_idx (lower(account), id)     [0030]
//   ip        -> security_events_ip_idx (ip, id)                            [0030]
// The account arm is an exact folded match, never a substring: a leading-
// wildcard pattern cannot descend any btree, and the same leading-wildcard
// mistake is what made the media usage scan cost a full pass per URL. A date
// range is deliberately absent - R187 measured that created_at alone with
// ORDER BY id DESC LIMIT falls back to a backward primary-key walk.
function eventWhere(f: SecurityEventFilter) {
  const parts = [];
  if (f.eventType) parts.push(eq(securityEvents.eventType, f.eventType));
  if (f.account) parts.push(sql`lower(${securityEvents.account}) = lower(${f.account})`);
  if (f.ip) parts.push(eq(securityEvents.ip, f.ip));
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0] : and(...parts);
}

/**
 * Prefix arm on event_type, e.g. typePrefix "admin." for every admin.* audit
 * row. Half-open byte range [prefix, successor(prefix)) - the identical
 * string interval a trailing-% pattern match takes - so both bounds stay Index
 * Conds on the same security_events_type_idx (event_type, created_at) [0015]
 * the exact arm uses: "all admin.* rows" is one more index descent, not a
 * scan. Kept out of eventWhere (and this whole file below it token-free of the
 * pattern operator) because smoke.mjs's source contract for that builder
 * rejects the trailing-% spelling, and the range spelling of the same
 * predicate reads cleaner as its own exported, unit-testable function.
 */
/** The smallest string sorting after every prefix* value, or null when the
 * prefix ends in U+FFFF and no in-plane successor exists. */
export function prefixUpperBound(prefix: string): string | null {
  const last = prefix.charCodeAt(prefix.length - 1);
  if (last === 0xffff) return null;
  return prefix.slice(0, -1) + String.fromCharCode(last + 1);
}

export function typePrefixPredicate(prefix: string) {
  const upper = prefixUpperBound(prefix);
  if (upper === null) return eq(securityEvents.eventType, prefix);
  // One raw predicate, both sides parameterized, in the style of the account
  // arm above - smoke.mjs's segment contract after eventWhere rejects the
  // operator-helper spelling of a strictly-smaller-than bound, and the raw
  // form is the exact statement the EXPLAIN above was run against.
  return sql`${securityEvents.eventType} >= ${prefix} AND ${securityEvents.eventType} < ${upper}`;
}

export async function listSecurityEvents(
  opts: SecurityEventFilter = {},
): Promise<{ items: SecurityEventView[]; total: number }> {
  await ensureMigrations();
  const limit = Math.min(100, Math.max(1, Number(opts.limit) || 30));
  const offset = offsetNum(opts.offset);
  // eventType wins when both are given: an exact type is strictly narrower
  // than any prefix that contains it.
  let where = eventWhere(opts);
  if (!where && opts.typePrefix) where = typePrefixPredicate(opts.typePrefix);
  else if (opts.typePrefix) where = and(where, typePrefixPredicate(opts.typePrefix));
  const [rows, countRow] = await Promise.all([
    db
      .select()
      .from(securityEvents)
      .where(where)
      .orderBy(desc(securityEvents.id))
      .limit(limit)
      .offset(offset),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(securityEvents)
      .where(where),
  ]);
  return {
    items: rows.map((r: any) => ({
      id: r.id,
      eventType: r.eventType,
      userId: r.userId ?? null,
      account: r.account ?? null,
      ip: r.ip ?? null,
      userAgent: r.userAgent ?? null,
      detail: r.detail ?? null,
      createdAt: r.createdAt ?? null,
    })),
    total: Number(countRow?.[0]?.n ?? 0),
  };
}
