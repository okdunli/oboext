// Content revision history — pre-update snapshots of posts/pages with
// restore. Snapshots are taken INSIDE create/update (not from the route
// layer) so every entry point — admin editor PUT, the server-side autosave
// and restore itself — leaves history behind. Retention is capped per
// target (OBOEXT_REVISION_KEEP, default 30).
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { db } from "./db.js";
import { contentRevisions } from "./schema.js";
import type { SessionUser } from "./auth.js";
import { ServiceError } from "./errors.js";
import { createLogger } from "./logger.js";
import { adminGetPost } from "./admin.js";
import { adminGetPage } from "./pages.js";
import { invalidateContentCaches } from "./cache.js";

const log = createLogger("revisions");

export type RevisionKind = "post" | "page";
export const REVISION_KEEP_DEFAULT = 30;

export function revisionKeep(): number {
  const raw = Number(process.env.OBOEXT_REVISION_KEEP || REVISION_KEEP_DEFAULT);
  if (!Number.isInteger(raw) || raw < 1) return REVISION_KEEP_DEFAULT;
  return Math.min(raw, 200);
}

// Ids arrive newest-first; everything past `keep` is stale. Pure so the
// retention rule can be unit-tested without a database.
export function pruneIds(ids: number[], keep: number): number[] {
  const k = Number.isInteger(keep) && keep > 0 ? keep : REVISION_KEEP_DEFAULT;
  return ids.slice(k).filter((n) => Number.isInteger(n) && n > 0);
}

export function buildRevisionRow(
  kind: RevisionKind,
  targetId: number,
  authorId: number | null | undefined,
  row: {
    title?: unknown;
    excerpt?: unknown;
    content?: unknown;
    status?: unknown;
  },
): {
  kind: RevisionKind;
  targetId: number;
  authorId: number | null;
  title: string;
  excerpt: string | null;
  content: unknown[];
  status: string;
} {
  return {
    kind,
    targetId,
    authorId: authorId == null ? null : authorId,
    title: typeof row.title === "string" ? row.title : "",
    excerpt: typeof row.excerpt === "string" ? row.excerpt : null,
    content: Array.isArray(row.content) ? row.content : [],
    status: typeof row.status === "string" ? row.status : "draft",
  };
}

// Never let a history write break a save: log and move on.
export async function snapshotRevision(
  kind: RevisionKind,
  targetId: number,
  authorId: number | null | undefined,
  row: { title?: unknown; excerpt?: unknown; content?: unknown; status?: unknown },
): Promise<void> {
  try {
    await db.insert(contentRevisions).values(buildRevisionRow(kind, targetId, authorId, row));
    await pruneRevisions(kind, targetId);
  } catch (e) {
    log.warn("snapshot failed", { kind, targetId, err: String(e) });
  }
}

async function pruneRevisions(kind: RevisionKind, targetId: number): Promise<void> {
  const ids = (
    await db
      .select({ id: contentRevisions.id })
      .from(contentRevisions)
      .where(and(eq(contentRevisions.kind, kind), eq(contentRevisions.targetId, targetId)))
      .orderBy(desc(contentRevisions.id))
  ).map((r) => r.id);
  const stale = pruneIds(ids, revisionKeep());
  if (stale.length) {
    await db.delete(contentRevisions).where(inArray(contentRevisions.id, stale));
  }
}

async function gateTarget(user: SessionUser, kind: RevisionKind, targetId: number) {
  if (kind === "post") return adminGetPost(user, targetId);
  if (kind === "page") return adminGetPage(user, targetId);
  throw new ServiceError("不支持的内容类型", 422);
}

export async function listRevisions(
  user: SessionUser,
  kind: RevisionKind,
  targetId: number,
  opts: { limit?: number; before?: number } = {},
) {
  await gateTarget(user, kind, targetId); // 404 + ownership
  const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 100);
  const conds = [eq(contentRevisions.kind, kind), eq(contentRevisions.targetId, targetId)];
  const before = Number(opts.before);
  if (Number.isInteger(before) && before > 0) conds.push(lt(contentRevisions.id, before));
  const rows = await db
    .select({
      id: contentRevisions.id,
      title: contentRevisions.title,
      excerpt: contentRevisions.excerpt,
      status: contentRevisions.status,
      createdAt: contentRevisions.createdAt,
    })
    .from(contentRevisions)
    .where(and(...conds))
    .orderBy(desc(contentRevisions.id))
    .limit(limit);
  const items = rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    excerpt: r.excerpt,
    createdAt: r.createdAt,
  }));
  return { items, nextBefore: items.length === limit ? items[items.length - 1].id : null };
}

export async function getRevision(user: SessionUser, kind: RevisionKind, id: number) {
  const [row] = await db.select().from(contentRevisions).where(eq(contentRevisions.id, id)).limit(1);
  if (!row || row.kind !== kind) throw new ServiceError("版本不存在", 404);
  return row;
}

// Restoring goes through the normal update path, which snapshots the
// pre-restore state first — so a restore is itself undoable.
export async function restoreRevision(
  user: SessionUser,
  kind: RevisionKind,
  targetId: number,
  revisionId: number,
) {
  const rev = await getRevision(user, kind, revisionId);
  if (rev.targetId !== targetId) throw new ServiceError("版本不存在", 404);
  await gateTarget(user, kind, targetId); // 404 + ownership
  const patch = {
    title: rev.title,
    excerpt: rev.excerpt ?? "",
    content: rev.content,
    status: rev.status,
  };
  if (kind === "post") {
    const { updatePost } = await import("./admin.js");
    const out = await updatePost(user, targetId, patch as any);
    invalidateContentCaches();
    return out;
  }
  const { updatePage } = await import("./pages.js");
  const out = await updatePage(user, targetId, patch as any);
  invalidateContentCaches();
  return out;
}
