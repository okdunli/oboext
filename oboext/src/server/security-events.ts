import { desc, eq, lt, sql } from "drizzle-orm";
import { db, ensureMigrations } from "./db.js";
import { securityEvents } from "./schema.js";
import { createLogger } from "./logger.js";
const log = createLogger("security-events");

// Retention: the events table only ever had INSERTs, so it grows forever.
let lastPruneAt = 0;
export async function pruneSecurityEvents(): Promise<void> {
  const now = Date.now();
  if (now - lastPruneAt < 3_600_000) return;
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

export async function listSecurityEvents(opts: {
  limit?: number;
  offset?: number;
  eventType?: string;
} = {}): Promise<{ items: SecurityEventView[]; total: number }> {
  await ensureMigrations();
  const limit = Math.min(100, Math.max(1, Number(opts.limit) || 30));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const where = opts.eventType ? eq(securityEvents.eventType, opts.eventType) : undefined;
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
