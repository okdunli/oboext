/**
 * Dual-driver lazy database client — ported from the original app
 * (db/index.ts), adapted for rosezm's server bundle.
 *
 * IMPORTANT: rosezm builds dist/server.js with esbuild `bundle: true` and
 * no external allowlist. @electric-sql/pglite ships WASM/data files and
 * cannot be inlined, so every driver package is loaded through a
 * NON-LITERAL dynamic import — esbuild leaves the expression alone and
 * Node resolves it from node_modules at runtime (Node deployment only,
 * exactly as the target architecture requires).
 *
 *  - Local:  DB_DRIVER=pglite (default), data dir ./.data/pglite_live
 *  - Prod:   DB_DRIVER=postgres + DATABASE_URL (managed Postgres)
 */
import fs from "fs";
import path from "path";
import { sql, type SQL } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "./schema";

/** The driver-agnostic handle shape both drivers satisfy for our call sites. */
export type Db = PgliteDatabase<typeof schema>;

type Driver = "pglite" | "postgres";

const globalForDb = globalThis as unknown as {
  __oboeDb?: any;
  __oboeMigrated?: Promise<void>;
  __oboeReady?: Promise<any>;
  __oboePglite?: any;
};

/**
 * Minimal .env.local loader. The rosezm CLI does not auto-load env files
 * (unlike the original runtime), so the installer-written config would otherwise only
 * apply to the process that received the POST. Real process env wins.
 */
function loadEnvLocal(): void {
  try {
    const file = path.join(process.cwd(), ".env.local");
    if (!fs.existsSync(file)) return;
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      if (Object.prototype.hasOwnProperty.call(process.env, m[1])) continue;
      let val = m[2];
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      process.env[m[1]] = val;
    }
  } catch {
    // optional config — an unreadable file must not block the default driver
  }
}
loadEnvLocal();

let pgliteClient: any = null;
let postgresClient: any = null;
let appLockPath: string | null = null;

/**
 * Single-instance interlock for a PGlite data directory. PGlite's own
 * postmaster.pid carries a WASM virtual PID (-42) that is never alive on the
 * host, so sweepStalePgLocks() cannot detect a SECOND process opening the same
 * directory. Two concurrent openers (a stale server + a restart, or a
 * multi-worker cluster) silently interleave file syncs and can tear
 * pg_control/WAL — "could not locate a valid checkpoint record" on the next
 * boot. This lock uses the REAL OS pid and atomically claims the directory.
 */
function acquireAppLock(dataDir: string): void {
  const lockPath = dataDir + ".app-lock";
  const reclaim = (): void => {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = Number.parseInt(
        fs.readFileSync(lockPath, "utf8").trim() || "0",
        10,
      );
      if (holder && holder !== process.pid && pidIsAlive(holder)) {
        throw new Error(
          `PGlite data directory ${dataDir} is already open in another oboext process (pid ${holder}). ` +
            "PGlite supports one process per data directory — stop that server first. " +
            `If it crashed without cleaning up, delete ${lockPath} and retry.`,
        );
      }
      fs.writeFileSync(lockPath, String(process.pid));
    }
  };
  reclaim();
  appLockPath = lockPath;
}

function releaseAppLock(): void {
  if (!appLockPath) return;
  try {
    if (fs.existsSync(appLockPath)) {
      if (fs.readFileSync(appLockPath, "utf8").trim() === String(process.pid)) {
        fs.rmSync(appLockPath, { force: true });
      }
    }
  } catch {
    // best effort — stale locks are reclaimed on next acquireAppLock()
  }
  appLockPath = null;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Remove crash-residue Postgres lock files before reopening a data dir. */
function sweepStalePgLocks(dataDir: string): void {
  try {
    const pidFile = path.join(dataDir, "postmaster.pid");
    if (!fs.existsSync(pidFile)) return;
    const holderPid = Number.parseInt(
      fs.readFileSync(pidFile, "utf8").split(/\r?\n/)[0] || "",
      10,
    );
    if (holderPid && pidIsAlive(holderPid)) {
      throw new Error(
        `PGlite data directory ${dataDir} is already in use by process ${holderPid}. ` +
          "Stop the other server and retry, or delete postmaster.pid manually.",
      );
    }
    for (const name of fs.readdirSync(dataDir)) {
      if (name === "postmaster.pid" || name.startsWith(".s.PGSQL.")) {
        fs.rmSync(path.join(dataDir, name), { force: true });
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("PGlite data directory")) throw err;
  }
}

function registerGracefulShutdown(): void {
  const g = globalThis as unknown as { __oboeDbShutdown?: boolean };
  if (g.__oboeDbShutdown) return;
  g.__oboeDbShutdown = true;
  const closeDb = () => {
    const client = pgliteClient;
    if (!client) return Promise.resolve();
    return client.close().catch((err: unknown) => {
      console.error("[db] PGlite close error:", err);
    }).finally(() => {
      releaseAppLock();
    });
  };
  const onSignal = (signal: NodeJS.Signals) => {
    const forceTimer = setTimeout(() => process.exit(1), 8000);
    forceTimer.unref?.();
    void closeDb().finally(() => {
      clearTimeout(forceTimer);
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    });
  };
  process.prependOnceListener("SIGINT", () => onSignal("SIGINT"));
  process.prependOnceListener("SIGTERM", () => onSignal("SIGTERM"));
  process.once("beforeExit", () => {
    void closeDb();
  });
  process.on("exit", () => {
    releaseAppLock();
  });
}

async function createDb(): Promise<any> {
  const driver: Driver = (process.env.DB_DRIVER || "pglite") as Driver;

  if (driver === "postgres") {
    const connectionString =
      process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        "DATABASE_URL is not set for DB_DRIVER=postgres. " +
          "Set DATABASE_URL (direct) or DATABASE_URL_UNPOOLED when using a pooled provider.",
      );
    }
    const pgPkg = "post" + "gres";
    const drvPkg = "drizzle-orm/postgres" + "-js";
    const [pgMod, drvMod] = await Promise.all([import(pgPkg), import(drvPkg)]);
    const client = pgMod.default(connectionString, {
      max: Number(process.env.POSTGRES_MAX || 1),
      prepare: false,
    });
    postgresClient = client;
    return drvMod.drizzle(client, { schema });
  }

  const url = process.env.DATABASE_URL || "./.data/pglite_live";
  const dir = path.resolve(url);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  acquireAppLock(dir);
  sweepStalePgLocks(dir);

  const pglitePkg = "@electric-sql/" + "pglite";
  const drvPkg = "drizzle-orm/" + "pglite";
  const [pgMod, drvMod] = await Promise.all([import(pglitePkg), import(drvPkg)]);
  const client = new pgMod.PGlite(dir, { relaxedDurability: true });
  pgliteClient = client;
  registerGracefulShutdown();
  return drvMod.drizzle(client, { schema });
}

/** Resolve (once) the lazily-created DB instance. */
export function ensureDb(): Promise<any> {
  if (!globalForDb.__oboeReady) {
    globalForDb.__oboeReady = createDb()
      .then((instance) => {
        globalForDb.__oboeDb = instance;
        return instance;
      })
      .catch((err) => {
        globalForDb.__oboeReady = undefined;
        throw err;
      });
  }
  return globalForDb.__oboeReady;
}

/**
 * Hot-swap the target database (ported 1:1 from db/index.ts
 * reconfigureDatabase): used by the installer's /api/db-config so a remote
 * Postgres chosen in the wizard takes effect immediately, no restart. The
 * next ensureMigrations() pass creates a fresh client and runs schema.
 */
export async function reconfigureDatabase(driver: Driver, url: string): Promise<void> {
  process.env.DB_DRIVER = driver;
  process.env.DATABASE_URL =
    driver === "postgres" ? url : url || "./.data/pglite_live";

  try {
    if (postgresClient) await postgresClient.end({ timeout: 2 });
    if (pgliteClient) await pgliteClient.close();
  } catch {
    // ignore teardown errors — a fresh client is created regardless
  }
  postgresClient = null;
  pgliteClient = null;
  releaseAppLock();
  globalForDb.__oboeDb = undefined;
  globalForDb.__oboeMigrated = undefined;
  globalForDb.__oboeReady = undefined;
}

export async function ping(): Promise<void> {
  const db = await ensureDb();
  await db.execute(sql`select 1`);
}

/**
 * Advance every public sequence that lags behind its table's max(id).
 *
 * Seed/reseed paths insert explicit ids, which does NOT advance the owning
 * sequence, so `nextval()` later hands back an id that already exists and
 * every insert fails with `duplicate key value violates unique constraint
 * "<table>_pkey"`. That surfaces as a 500 on "new post" / "new page" in the
 * admin, which reads as "the app is broken" while the data is fine.
 *
 * Only ever moves a sequence FORWARD: a sequence already past max(id) (rows
 * were deleted) is left alone, so ids are never reused. Tables are derived by
 * stripping the `_id_seq` suffix; anything that does not resolve is skipped,
 * keeping this best-effort and safe on partial schemas.
 */
async function resyncSequences(): Promise<void> {
  const seqs = await rawQuery<{ sequencename: string }>(
    `select sequencename from pg_sequences where schemaname = 'public'`,
  );
  for (const { sequencename } of seqs) {
    const table = sequencename.replace(/_id_seq$/, "");
    try {
        // one round trip per sequence: the read of max(id) + last_value and the
        // conditional setval run as a single statement, so cold-boot sequence
        // traffic drops from 2 queries/sequence to 1. A missing "<table>" still
        // throws and is swallowed here exactly as before.
        await rawQuery(
          `select case when (select coalesce(max(id), 0) + 1 from "${table}") > (select last_value from "${sequencename}")
                        then setval($1::text::regclass, (select coalesce(max(id), 0) + 1 from "${table}"), false) end`,
          [sequencename],
        );
        } catch {
      // no matching "<table>" (or no id column) — not a serial we manage
    }
  }
}

/** Apply SQL migrations once per process; safe to await every request. */
export function ensureMigrations(): Promise<void> {
  if (!globalForDb.__oboeMigrated) {
    globalForDb.__oboeMigrated = (async () => {
      await ensureDb();
      const folder = path.resolve(process.cwd(), "db/migrations");
      if (postgresClient) {
        const drvPkg = "drizzle-orm/postgres" + "-js";
        const migPkg = drvPkg + "/migrator";
        const drvMod = await import(drvPkg);
        const { migrate } = await import(migPkg);
        await migrate(drvMod.drizzle(postgresClient, { schema }), { migrationsFolder: folder });
      } else if (pgliteClient) {
        const drvPkg = "drizzle-orm/" + "pglite";
        const { migrate } = await import(drvPkg + "/migrator");
        await migrate(globalForDb.__oboeDb, { migrationsFolder: folder });
      }
      await resyncSequences();
    })().catch((err) => {
      globalForDb.__oboeMigrated = undefined;
      throw err;
    });
  }
  return globalForDb.__oboeMigrated;
}

/**
 * DB handle. Only valid after ensureDb()/ensureMigrations() resolved —
 * the middleware awaits that before any render.
 */
export const db = new Proxy({} as Db, {
  get(_target, prop) {
    const instance = globalForDb.__oboeDb;
    if (!instance) {
      throw new Error("db used before ensureDb() resolved");
    }
    return Reflect.get(instance, prop);
  },
});

/** Driver-agnostic raw SQL with $1/$2 bindings. */
export async function rawQuery<T = Record<string, unknown>>(
  query: string,
  params: unknown[] = [],
): Promise<T[]> {
  await ensureDb();
  const instance = globalForDb.__oboeDb;
  let built: SQL = sql``;
  const re = /\$(\d+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query))) {
    built.append(sql.raw(query.slice(last, m.index)));
    built.append(sql`${params[Number(m[1]) - 1]}`);
    last = m.index + m[0].length;
  }
  built.append(sql.raw(query.slice(last)));
  const res: unknown = await instance.execute(built);
  if (Array.isArray(res)) return res as T[];
  return ((res as { rows?: T[] }).rows ?? []) as T[];
}

export { schema };

/**
 * Boot-time warmup (T11 follow-up): kick the memoized ensureMigrations() at
 * module load, so PGlite opens, migrations apply and sequences resync while
 * the server is still starting — instead of the first request paying the
 * whole 3s+ cold path. ensureMigrations() is idempotent (one memoized promise
 * on globalThis) and every later awaiter shares this very promise, so this
 * is purely a scheduling change with zero behavioral delta. The detached
 * catch only prevents an unused-promise unhandled rejection; the memoized
 * promise keeps its error for the middleware's real await, and a failed
 * warmup self-clears so the next request retries.
 */
void ensureMigrations().catch(() => {});
