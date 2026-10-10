/**
 * Dual-driver lazy database client — ported from the original
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
 *  - Prod:   DB_DRIVER=postgres + DATABASE_URL (Neon / Vercel Postgres)
 */
import fs from "node:fs";
import path from "node:path";
import { sql, type SQL } from "drizzle-orm";
import * as schema from "./schema";

type Driver = "pglite" | "postgres";

const globalForDb = globalThis as unknown as {
  __oboeDb?: any;
  __oboeMigrated?: Promise<void>;
  __oboeReady?: Promise<any>;
  __oboePglite?: any;
};

let pgliteClient: any = null;
let postgresClient: any = null;

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
}

async function createDb(): Promise<any> {
  const driver: Driver = (process.env.DB_DRIVER || "pglite") as Driver;

  if (driver === "postgres") {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set for DB_DRIVER=postgres.");
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
  sweepStalePgLocks(dir);

  const pglitePkg = "@electric-sql/" + "pglite";
  const drvPkg = "drizzle-orm/" + "pglite";
  const [pgMod, drvMod] = await Promise.all([import(pglitePkg), import(drvPkg)]);
  const client = new pgMod.PGlite(dir, { relaxedDurability: true });
  pgliteClient = client;
  registerGracefulShutdown();
  return drvMod.drizzle(client, { schema });
}

/** Resolve (once) the lazily-created drizzle instance. */
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
    })().catch((err) => {
      globalForDb.__oboeMigrated = undefined;
      throw err;
    });
  }
  return globalForDb.__oboeMigrated;
}

/**
 * Drizzle handle. Only valid after ensureDb()/ensureMigrations() resolved —
 * the middleware awaits that before any render.
 */
export const db = new Proxy({} as any, {
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
