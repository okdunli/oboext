import fs from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import { db, rawQuery } from "./db.js";
import { invalidateOptionCache } from "./options.js";
import { invalidateSettings } from "./queries.js";
import { reloadPlugins } from "./plugins.js";
import { ServiceError } from "./errors.js";
import { createLogger } from "./logger.js";
const log = createLogger("backup");

export const BACKUP_KIND = "oboext-db-backup";
const BACKUP_VERSION = 1;
const SKIP_TABLES = new Set(["__drizzle_migrations"]);

const AUTO_DIR = path.resolve(process.cwd(), ".data/backups");
const AUTO_PREFIX = "auto-before-restore-";
const AUTO_KEEP = 10;

export interface DatabaseBackup {
  tool: "oboext";
  kind: typeof BACKUP_KIND;
  version: number;
  createdAt: string;

  tables: Record<string, Record<string, unknown>[]>;
}

export interface RestoreResult {

  restored: Record<string, number>;

  missingTables: string[];

  droppedColumns: Record<string, string[]>;

  autoSnapshot?: string;
}

interface ColumnMeta {
  name: string;

  type: string;
}
interface TableMeta {
  name: string;
  columns: ColumnMeta[];
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function listTableMetas(): Promise<TableMeta[]> {
  const rows = await rawQuery<{
    table_name: string;
    ordinal: number;
    column_name: string;
    data_type: string;
    udt_name: string;
  }>(`
    SELECT c.table_name,
           c.ordinal_position::int AS ordinal,
           c.column_name,
           c.data_type,
           c.udt_name
    FROM information_schema.tables t
    JOIN information_schema.columns c
      ON c.table_name = t.table_name AND c.table_schema = t.table_schema
    WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_name, c.ordinal_position
  `);
  const map = new Map<string, TableMeta>();
  for (const r of rows) {
    if (SKIP_TABLES.has(r.table_name)) continue;
    let t = map.get(r.table_name);
    if (!t) {
      t = { name: r.table_name, columns: [] };
      map.set(r.table_name, t);
    }
    t.columns.push({ name: r.column_name, type: r.data_type === "ARRAY" ? r.udt_name : r.udt_name });
  }
  return [...map.values()];
}

export async function buildDatabaseBackup(): Promise<DatabaseBackup> {
  const metas = await listTableMetas();
  const tables: DatabaseBackup["tables"] = {};
  for (const t of metas) {
    const rows = await rawQuery(`SELECT * FROM ${quoteIdent(t.name)}`);
    tables[t.name] = rows as Record<string, unknown>[];
  }
  return {
    tool: "oboext",
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    tables,
  };
}

async function fkOrder(names: Set<string>): Promise<string[]> {
  const edges = await rawQuery<{ child: string; parent: string }>(`
    SELECT cl.relname AS child, cr.relname AS parent
    FROM pg_constraint k
    JOIN pg_class cl ON cl.oid = k.conrelid
    JOIN pg_namespace nl ON nl.oid = cl.relnamespace
    JOIN pg_class cr ON cr.oid = k.confrelid
    JOIN pg_namespace nr ON nr.oid = cr.relnamespace
    WHERE k.contype = 'f' AND nl.nspname = 'public' AND nr.nspname = 'public'
  `);
  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const n of names) {
    indegree.set(n, 0);
    adjacency.set(n, []);
  }
  for (const { child, parent } of edges) {
    if (child === parent) continue;
    if (!names.has(child) || !names.has(parent)) continue;
    adjacency.get(parent)!.push(child);
    indegree.set(child, (indegree.get(child) ?? 0) + 1);
  }
  const queue = [...names].filter((n) => (indegree.get(n) ?? 0) === 0).sort();
  const ordered: string[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    ordered.push(n);
    for (const child of adjacency.get(n) ?? []) {
      const d = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, d);
      if (d === 0) queue.push(child);
    }
  }

  for (const n of [...names].sort()) if (!ordered.includes(n)) ordered.push(n);
  return ordered;
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
}

async function writeAutoSnapshot(): Promise<string | undefined> {
  try {
    await fs.mkdir(AUTO_DIR, { recursive: true });
    const file = path.join(AUTO_DIR, `${AUTO_PREFIX}${stamp()}.json`);
    const snap = await buildDatabaseBackup();
    await fs.writeFile(file, JSON.stringify(snap), "utf-8");

    const all = (await fs.readdir(AUTO_DIR))
      .filter((f) => f.startsWith(AUTO_PREFIX) && f.endsWith(".json"))
      .sort()
      .reverse();
    await Promise.all(all.slice(AUTO_KEEP).map((f) => fs.rm(path.join(AUTO_DIR, f), { force: true })));
    return file;
  } catch (err) {
    log.warn("[backup] 恢复前自动快照失败（已忽略）:", err);
    return undefined;
  }
}

function assertBackup(input: unknown): DatabaseBackup {
  if (typeof input !== "object" || input === null) {
    throw new ServiceError("备份文件不是合法对象", 400);
  }
  const b = input as Partial<DatabaseBackup>;
  if (b.kind !== BACKUP_KIND) {
    throw new ServiceError("文件格式不是 Oboext 整库备份", 400);
  }
  if (b.version !== 1 || typeof b.tables !== "object" || b.tables === null) {
    throw new ServiceError("备份文件缺少版本号或数据表", 400);
  }
  for (const [name, rows] of Object.entries(b.tables)) {
    if (!Array.isArray(rows) || rows.some((r) => typeof r !== "object" || r === null)) {
      throw new ServiceError(`表 ${name} 的备份数据结构非法`, 400);
    }
  }
  return b as DatabaseBackup;
}

export async function restoreDatabaseBackup(input: unknown): Promise<RestoreResult> {
  const backup = assertBackup(input);
  const backupTables = Object.keys(backup.tables);
  const metas = await listTableMetas();
  const metaByName = new Map(metas.map((t) => [t.name, t]));

  const missingTables: string[] = [];
  const present = new Set<string>();
  for (const name of backupTables) {
    if (metaByName.has(name)) present.add(name);
    else missingTables.push(name);
  }
  const droppedColumns: Record<string, string[]> = {};
  for (const name of present) {
    const currentCols = new Set(metaByName.get(name)!.columns.map((c) => c.name));
    const inBackup = new Set(
      Object.keys((backup.tables[name] as Record<string, unknown>[])[0] ?? {}),
    );
    const gone = [...inBackup].filter((c) => !currentCols.has(c));
    if (gone.length) droppedColumns[name] = gone;
  }

  const autoSnapshot = await writeAutoSnapshot();

  const ordered = await fkOrder(present);

  const sequences = await rawQuery<{ table_name: string; column_name: string; seq: string }>(`
    SELECT table_name, column_name,
           pg_get_serial_sequence(quote_ident(table_name), column_name) AS seq
    FROM information_schema.columns
    WHERE table_schema = 'public' AND column_default LIKE 'nextval%'
  `);

  await db.transaction(async (tx: any) => {
    if (ordered.length) {

      const list = ordered.map(quoteIdent).join(", ");
      await tx.execute(sql`TRUNCATE TABLE ${sql.raw(list)} RESTART IDENTITY CASCADE`);
    }

    for (const name of ordered) {
      const rows = backup.tables[name];
      if (!rows.length) continue;
      const meta = metaByName.get(name)!;
      const cols = meta.columns;
      const colCsv = cols.map((c) => quoteIdent(c.name)).join(", ");
      const defs = cols.map((c) => `${quoteIdent(c.name)} ${c.type}`).join(", ");

      const sorted = [...rows].sort((a, b) => {
        const x = Number(a.id);
        const y = Number(b.id);
        if (Number.isFinite(x) && Number.isFinite(y)) return x - y;
        return 0;
      });
      const picked = sorted.map((r) => {
        const out: Record<string, unknown> = {};
        for (const c of cols) out[c.name] = r[c.name] ?? null;
        return out;
      });
      await tx.execute(sql`
        INSERT INTO ${sql.raw(quoteIdent(name))} (${sql.raw(colCsv)})
        SELECT ${sql.raw(colCsv)}
        FROM jsonb_to_recordset((${JSON.stringify(picked)})::jsonb)
          AS (${sql.raw(defs)})
      `);
    }

    for (const s of sequences) {
      if (!present.has(s.table_name) || !s.seq) continue;
      await tx.execute(sql`
        SELECT setval(
          ${s.seq},
          GREATEST(COALESCE((SELECT MAX(${sql.raw(quoteIdent(s.column_name))}) FROM ${sql.raw(
            quoteIdent(s.table_name),
          )}), 1), 1),
          (SELECT MAX(${sql.raw(quoteIdent(s.column_name))}) FROM ${sql.raw(
            quoteIdent(s.table_name),
          )}) IS NOT NULL
        )
      `);
    }
  });

  invalidateOptionCache();
  invalidateSettings();
  await reloadPlugins();

  const restored: Record<string, number> = {};
  for (const name of ordered) restored[name] = backup.tables[name].length;
  return { restored, missingTables, droppedColumns, autoSnapshot };
}
