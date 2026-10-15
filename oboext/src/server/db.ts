// Dual-driver lazy database client — ported from the original app (db/index.ts), adapted for rosefd's server bundle.
import fs from "fs";
import path from "path";
import { sql, type SQL } from "drizzle-orm";
// Type-only: a value import would pull the driver into the esbuild bundle.
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "./schema";
import { createLogger } from "./logger.js";
const log = createLogger("db");

// Resolved off globalThis: a static import would be inlined as a second copy
// of the registry, and the server would drain a copy the app never saw.
function onPgliteShutdown(fn: () => Promise<void>): () => void {
  const g = globalThis as unknown as {
    __rosefdOnShutdown?: (name: string, f: () => void | Promise<void>) => () => void;
  };
  if (typeof g.__rosefdOnShutdown !== "function") {
    // No framework registry (a bare script, a test harness): the direct
    // signal handlers in registerGracefulShutdown() still cover it.
    return () => {};
  }
  return g.__rosefdOnShutdown("pglite-close", fn);
}

/** The driver-agnostic handle shape both drivers satisfy for our call sites. */
export type Db = PgliteDatabase<typeof schema>;

type Driver = "pglite" | "postgres";

const globalForDb = globalThis as unknown as {
  __oboeDb?: any;
  __oboeMigrated?: Promise<void>;
  __oboeReady?: Promise<any>;
  __oboePglite?: any;
  // Published so the rosefd framework's render entry points (renderPage / renderPageStream) can await database readiness before painting a page.
  __rosefdAppReady?: Promise<void>;
};

// Minimal .env.local loader.
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

// Single-instance interlock for a PGlite data directory.
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

/**
 * Close PGlite on SIGINT/SIGTERM. An embedded Postgres keeps its WAL and
 * dirty pages in process memory and writes them out on close(); a hard exit
 * loses whatever was unflushed, and the next boot replays a partial WAL, which
 * is where "could not locate a valid checkpoint record" comes from.
 */
function registerGracefulShutdown(): () => void {
  const g = globalThis as unknown as {
    __oboeDbUnregister?: () => void;
    __oboeDbClosed?: Promise<void> | null;
  };
  // Replace the previous hook: reconfigureDatabase() swaps clients without the
  // process exiting, and a stale hook would close the replacement.
  g.__oboeDbUnregister?.();

  const closeDb = async (): Promise<void> => {
    const client = pgliteClient;
    pgliteClient = null;
    if (!client || client.closed) return;
    const snap = snapshotPath(currentDataDir);
    try {
      // CHECKPOINT first: it flushes dirty buffers into the data files and
      // makes the WAL redundant, so a close() that dies halfway leaves a
      // directory that still opens. Cheap enough to always run - measured at
      // single-digit milliseconds against an embedded instance.
      await client.query("CHECKPOINT");
    } catch (err) {
      // A checkpoint failure (already closed, read-only dir) must not stop
      // the close itself - close() is what releases the file handles.
      log.error("[db] PGlite checkpoint before close failed:", (err as Error)?.message ?? err);
    }
    // Snapshot AFTER the checkpoint and BEFORE the close, because
    // dumpDataDir() reads a LIVE instance - there is nothing to dump once
    // close() has released it. The checkpoint above is what makes the
    // captured tar self-consistent: without it the snapshot would carry the
    // WAL the close had not flushed yet, i.e. exactly the state this whole
    // mechanism exists to avoid persisting.
    await writeRecoverySnapshot(client, snap);
    try {
      await client.close();
      log.info(`[db] PGlite closed cleanly (checkpoint + WAL flushed, snapshot at ${snap})`);
    } catch (err) {
      log.error("[db] PGlite close error:", (err as Error)?.message ?? err);
    }
  };

  // One close per client: PGlite throws "PGlite is closing" on a second one,
  // and two racing closes are a corruption path in themselves.
  g.__oboeDbClosed = null;
  const once = (): Promise<void> => {
    if (!g.__oboeDbClosed) {
      g.__oboeDbClosed = closeDb().finally(() => {
        g.__oboeDbClosed = null;
      });
    }
    return g.__oboeDbClosed;
  };

  const onSignal = (signal: NodeJS.Signals) => {
    const forceTimer = setTimeout(() => process.exit(1), 8000);
    forceTimer.unref?.();
    void once().finally(() => {
      clearTimeout(forceTimer);
      releaseAppLock();
      process.removeAllListeners(signal);
      // Restore the default disposition so the exit code reflects the signal.
      process.kill(process.pid, signal);
    });
  };
  process.prependOnceListener("SIGINT", () => onSignal("SIGINT"));
  process.prependOnceListener("SIGTERM", () => onSignal("SIGTERM"));
  process.once("beforeExit", () => {
    void once();
  });
  // 'exit' only allows synchronous work; the close already ran above.
  process.on("exit", () => {
    releaseAppLock();
  });

  return onPgliteShutdown(once);
}

/**
 * Connection-string selection for THIS project's Neon setup (verified
 * 2026-10-06):
 *
 * The Neon/Vercel integration provisions a pooled `DATABASE_URL` whose host
 * does NOT resolve — `getaddrinfo ENOTFOUND
 * ep-xxx-pooler.c-14.us-east-1.aws-pooler.neon.tech`. The pooler segment is
 * mangled (it keeps the compute id and uses `aws-pooler.neon.tech` instead of
 * the real `aws.neon.tech`), so the pooled endpoint is unusable — every
 * connection to it fails fast with `write CONNECT_TIMEOUT undefined:undefined`
 * (the socket never gets a remote address). The `DATABASE_URL_UNPOOLED`
 * direct endpoint, by contrast, resolves and connects cleanly.
 *
 * We therefore route BOTH runtime and migrations through the direct endpoint
 * via pickPostgresUrl() (which prefers UNPOOLED and validates the host), and
 * absorb Neon's cold-start wake-up with connect_timeout + the ensureDb retry
 * backoff. Do NOT reintroduce a `-pooler` host derivation — it produces a host
 * that does not exist.
 */
/** Migrations use the direct endpoint for their session-level advisory locks;
 *  the runtime client does too (see above), so this is a no-op on a clean
 *  UNPOOLED URL but keeps a stray `-pooler` host from slipping through. */
function toDirectUrl(url: string | undefined): string {
  if (!url) return "";
  return /-pooler\./i.test(url) ? url.replace(/-pooler\./i, ".") : url;
}

/**
 * Pick the working Postgres connection string from the env.
 *
 * Both `DATABASE_URL` and `DATABASE_URL_UNPOOLED` may be present — and either
 * (or both) can be a placeholder / hostless value (e.g. a stale `postgres://`
 * left by a partial Neon integration or a manual env override). A hostless
 * string makes postgres.js fail instantly with `write CONNECT_TIMEOUT
 * undefined:undefined`, and because migrations read the *other* variable they
 * can still succeed — which is exactly the "migrations OK but every request
 * 500s" symptom. We validate that a candidate actually has a host before using
 * it, and prefer `DATABASE_URL_UNPOOLED` (the value migrations use, so the
 * runtime client connects through the same proven-good endpoint). `new URL`
 * throws on a hostless string, so the try/catch doubles as the validator.
 */
function pickPostgresUrl(): string {
  const candidates = [
    process.env.DATABASE_URL_UNPOOLED,
    process.env.DATABASE_URL,
  ];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const u = new URL(c);
      if ((u.protocol === "postgres:" || u.protocol === "postgresql:") && u.hostname) {
        return c;
      }
    } catch {
      // not a parseable postgres URL (e.g. "postgres://") — skip it
    }
  }
  return candidates.find((c) => !!c) ?? "";
}

/** Log the host being connected to without leaking credentials. */
function logDbTarget(label: string, url: string): void {
  try {
    const u = new URL(url);
    log.info(
      `[db] ${label} -> postgres://${u.hostname}:${u.port || 5432} (db=${u.pathname.slice(1) || "-"})`,
    );
  } catch {
    log.info(`[db] ${label} -> (unparseable connection string; check DATABASE_URL / DATABASE_URL_UNPOOLED)`);
  }
}

/**
 * Keep a Neon serverless connection from ever suspending.
 *
 * Neon compute suspends after an idle period; the next real request then pays a
 * 5-8s wake-up handshake before any query runs (observed in the field: a
 * postDetail render took 9.79s with the DB layer reporting `dbTime=2ms` — the
 * entire cost was the cold connection, not the queries). A trivial periodic
 * ping keeps the socket active so visitors never hit that penalty.
 *
 * Deliberately scoped: only when the driver is postgres AND the host is Neon
 * (or DB_KEEPALIVE=1 is set), and never inside serverless (Vercel / AWS Lambda)
 * where there is no long-lived process to keep warm and the timer would only
 * delay the freeze. `unref()` so the ping alone never holds the event loop open,
 * and it is cleared on framework shutdown via __rosefdOnShutdown.
 */
function maybeStartDbKeepalive(connectionString: string): void {
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) return;
  const isNeon = /neon\.(tech|vc)/i.test(connectionString);
  if (!isNeon && process.env.DB_KEEPALIVE !== "1") return;
  if (!postgresClient) return;
  const ms = Number(process.env.DB_KEEPALIVE_MS || 20000);
  if (!(ms > 0)) return;
  log.debug("[db] keepalive started interval=" + ms + "ms");
  let warned = false;
  const timer = setInterval(async () => {
    try {
      await postgresClient.unsafe("select 1");
      warned = false;
    } catch (e) {
      if (!warned) {
        warned = true;
        log.debug("[db] keepalive ping failed: " + (e && (e as Error).message) + " (will retry)");
      }
    }
  }, ms);
  if (typeof (timer as any).unref === "function") (timer as any).unref();
  const g = globalThis as unknown as {
    __rosefdOnShutdown?: (name: string, f: () => void | Promise<void>) => () => void;
  };
  if (typeof g.__rosefdOnShutdown === "function") {
    g.__rosefdOnShutdown("db-keepalive", () => clearInterval(timer));
  }
}

async function createDb(): Promise<any> {
  const driver: Driver = (process.env.DB_DRIVER || "pglite") as Driver;

  if (driver === "postgres") {
    // Runtime queries go through the DIRECT (unpooled) endpoint. In this
    // project's Neon/Vercel integration the provisioned pooled DATABASE_URL has
    // a mangled, non-resolving host (getaddrinfo ENOTFOUND
    // ep-xxx-pooler.c-14.us-east-1.aws-pooler.neon.tech), so the pooler is
    // unusable — the direct DATABASE_URL_UNPOOLED endpoint resolves and
    // connects cleanly (verified). pickPostgresUrl() prefers UNPOOLED and
    // validates the host, so this is the safe, working target. Cold-start
    // wake-up is absorbed by connect_timeout + the ensureDb retry backoff below.
    const connectionString = pickPostgresUrl();
    logDbTarget("runtime (direct)", connectionString);
    if (!connectionString) {
      throw new Error(
        "DATABASE_URL is not set for DB_DRIVER=postgres. " +
          "Set DATABASE_URL (pooled) or DATABASE_URL_UNPOOLED when using a pooled provider.",
      );
    }
    // Non-literal specifiers keep these out of the esbuild bundle.
    const pgPkg = "post" + "gres";
    const drvPkg = "drizzle-orm/postgres" + "-js";
    const [pgMod, drvMod] = await Promise.all([import(pgPkg), import(drvPkg)]);
    const client = pgMod.default(connectionString, {
      // >1 so the 30~50 queries a single page render fans out do not all queue
      // on a single connection. A suspended compute amplifies the latency of
      // every one of them, and max=1 turns that into a guaranteed timeout.
      max: Number(process.env.POSTGRES_MAX || 4),
      prepare: false,
      // Must stay BELOW the platform's function ceiling, or the timeout can
      // never fire: Vercel kills the invocation at maxDuration and withDbRetry
      // never gets the chance to reconnect. 8s leaves room for the retry
      // backoff to run inside a 10s (Hobby) budget. Raise via
      // POSTGRES_CONNECT_TIMEOUT only together with maxDuration.
      connect_timeout: Number(process.env.POSTGRES_CONNECT_TIMEOUT || 8),
    });
    postgresClient = client;
    maybeStartDbKeepalive(connectionString);
    return drvMod.drizzle(client, { schema, logger: queryLogger() });
  }

  // A Postgres connection string in DATABASE_URL is not a filesystem path.
  // The installer stores the data dir there for pglite, but `vercel env pull`
  // (or a copied .env.local) overwrites it with a real URL, and opening that
  // as a directory fails with ENOENT on a path named after the URL.
  const configured =
    process.env.PGLITE_DATA_DIR || process.env.DATABASE_URL || "./.data/pglite_live";
  const url = /^(postgres|postgresql):\/\//i.test(configured)
    ? "./.data/pglite_live"
    : configured;
  const dir = path.resolve(url);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  acquireAppLock(dir);
  sweepStalePgLocks(dir);

  const pglitePkg = "@electric-sql/" + "pglite";
  const drvPkg = "drizzle-orm/" + "pglite";
  const [pgMod, drvPkgMod] = await Promise.all([import(pglitePkg), import(drvPkg)]);

  currentDataDir = dir;
  // Open, and if the directory is unreadable, try to recover it from the
  // last good snapshot before giving up (see openPgliteWithRecovery).
  const { client, recovered } = await openPgliteWithRecovery(pgMod, dir);
  if (recovered) {
    log.warn(
      `[db] PGlite data directory ${dir} was unreadable and has been restored from ${snapshotPath(dir)}`,
    );
  }
  pgliteClient = client;
  const unregister = registerGracefulShutdown();
  (globalThis as unknown as { __oboeDbUnregister?: () => void }).__oboeDbUnregister = unregister;
  await tunePersistence(client);
  return drvPkgMod.drizzle(client, { schema, logger: queryLogger() });
}

/**
 * OBOEXT_DB_STATS=1 counts queries and their wall time. drizzle's logQuery
 * fires after a query returns, so the gap between two calls is that query's
 * cost plus the JS between them - close enough to compare configurations.
 */
type DbStats = {
  count: number;
  total: number;
  last: number;
  samples: { q: string; ms: number }[];
};

function queryLogger(): undefined | { logQuery: (q: string, p: unknown[]) => void } {
  if (process.env.OBOEXT_DB_STATS !== "1") return undefined;
  const g = globalThis as unknown as { __oboeDbStats?: DbStats };
  if (!g.__oboeDbStats) g.__oboeDbStats = { count: 0, total: 0, last: Date.now(), samples: [] };
  return {
    logQuery(query: string, _params: unknown[]) {
      const s = g.__oboeDbStats!;
      const now = Date.now();
      const ms = now - s.last;
      s.last = now;
      s.count++;
      s.total += ms;
      const one = query.replace(/\s+/g, " ").slice(0, 160);
      if (s.samples.length < 400) s.samples.push({ q: one, ms });
      log.debug(`[q] ${ms}ms  ${one}`);
    },
  };
}

/**
 * OBOEXT_DB_STATS=1 counts queries and their wall time. drizzle's logQuery
 * fires after a query returns, so the gap between two calls is that query's
 * cost plus the JS between them - close enough to compare configurations.
 */
export function dbStats(): { count: number; total: number; samples: { q: string; ms: number }[] } {
  const s = (globalThis as unknown as { __oboeDbStats?: DbStats }).__oboeDbStats;
  if (!s) return { count: 0, total: 0, samples: [] };
  return { count: s.count, total: s.total, samples: s.samples };
}

/**
 * Shrink the loss window on a hard kill: a short checkpoint interval forces
 * dirty buffers out without waiting for shutdown, and wal_keep_size keeps the
 * segments a crash replay needs. Costs more frequent checkpoints.
 *
 * ALTER SYSTEM, not SET. On PGlite 0.2.17 these are postmaster-level
 * parameters and SET is silently ineffective - it does not raise, and
 * `show shared_buffers` still returns 128MB. ALTER SYSTEM writes
 * postgresql.auto.conf and survives a reopen. shared_buffers/wal_buffers stay
 * fixed regardless (compiled into the WASM), so the cache size itself is not
 * tunable here - only the checkpoint cadence is.
 */
async function tunePersistence(client: any): Promise<void> {
  if (process.env.OBOEXT_PGLITE_TUNING === "0") return;
  const settings: Array<[string, string]> = [
    ["checkpoint_timeout", "30s"],
    ["wal_keep_size", "64MB"],
    ["max_wal_size", "64MB"],
    ["full_page_writes", "on"],
  ];
  const applied: string[] = [];
  const rejected: string[] = [];
  for (const [key, value] of settings) {
    try {
      await client.exec(`ALTER SYSTEM SET ${key} = '${value}'`);
      applied.push(`${key}=${value}`);
    } catch (err) {
      rejected.push(`${key} (${(err as Error)?.message ?? err})`);
    }
  }
  // A reload makes the checkpoint interval take effect for the CURRENT
  // process too, not only the next boot: the value is read when the checkpointer
  // is (re)started.
  try {
    await client.exec("SELECT pg_reload_conf()");
  } catch {
    // No reload needed on some builds; the next boot picks it up regardless.
  }
  log.info(
    `[db] PGlite persistence tuned via postgresql.auto.conf: ${applied.join(", ") || "nothing applied"}` +
      (rejected.length ? ` (rejected: ${rejected.join(", ")})` : "") +
      "  [shared_buffers/wal_buffers are fixed in the PGlite WASM build and cannot be changed]",
  );
  if (process.env.OBOEXT_PGLITE_TUNING === "1") {
    // Diagnostic mode: prove the values the next boot will actually see.
    for (const key of ["checkpoint_timeout", "wal_keep_size", "shared_buffers"]) {
      const v = await client.query("show " + key).then((r: any) => r.rows[0]?.[key]).catch(() => "?");
      log.debug(`[db]   ${key} = ${v}`);
    }
  }
}

/** Where the recovery snapshot for a data directory lives. */
function snapshotPath(dir: string): string {
  return dir + ".snapshot.tar";
}

/** The directory the open client is using (the hook runs before it is cleared). */
let currentDataDir = "";

/**
 * Write the recovery snapshot from a live instance.
 *
 * Atomic by way of write-then-rename: a snapshot half-written is worse than
 * no snapshot, because the next boot would restore a truncated archive and
 * report success doing it. Best effort by design - a snapshot that cannot be
 * written (full disk, no permission) must never turn a clean shutdown into a
 * failed one, so the error is logged and the close continues.
 */
async function writeRecoverySnapshot(client: any, snap: string): Promise<void> {
  if (process.env.OBOEXT_PGLITE_SNAPSHOT === "0") return;
  const tmp = snap + ".tmp-" + process.pid;
  try {
    const blob = await client.dumpDataDir();
    const buf = Buffer.from(await blob.arrayBuffer());
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, snap);
    log.info(
      `[db] recovery snapshot written: ${snap} (${(buf.length / 1048576).toFixed(1)} MB)`,
    );
  } catch (err) {
    log.error(
      "[db] recovery snapshot failed (the close itself is unaffected):",
      (err as Error)?.message ?? err,
    );
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // a leftover .tmp is inert; the next successful write replaces it
    }
  }
}

/**
 * Open a PGlite data directory, restoring it from the last snapshot if it will
 * not open.
 *
 * PGlite has no pg_resetwal, but dumpDataDir()/loadDataDir give a strictly
 * better equivalent: the damaged directory is replaced wholesale by the last
 * known-good one, so pre-snapshot data survives where pg_resetwal would
 * discard it. The snapshot is written on clean shutdown rather than on a
 * timer, because a timer would keep snapshotting an already-damaged directory.
 * OBOEXT_PGLITE_RECOVER=1 forces the attempt with no snapshot present.
 */
async function openPgliteWithRecovery(
  pgMod: any,
  dir: string,
): Promise<{ client: any; recovered: boolean }> {
  const PGliteCtor = pgMod.PGlite;
  const snap = snapshotPath(dir);
  const hasSnapshot = fs.existsSync(snap);
  const forced = process.env.OBOEXT_PGLITE_RECOVER === "1";

  try {
    const client = new PGliteCtor(dir, pgliteOptions());
    await client.waitReady;
    return { client, recovered: false };
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    if (!isCorruptionError(message) || (!hasSnapshot && !forced)) {
      throw describeUnopenable(dir, message, hasSnapshot, forced);
    }
    log.error(`[db] PGlite cannot open ${dir}: ${message}`);
    if (!hasSnapshot) {
      throw new Error(
        `PGlite data directory ${dir} is damaged (${message}) and no snapshot exists at ${snap}. ` +
          "Nothing can be recovered automatically - move the directory aside to start empty, " +
          "or restore a backup.",
      );
    }
    // Moved aside rather than deleted, so the wreck survives for a post-mortem.
    const wreck = dir + ".damaged-" + Date.now();
    try {
      fs.renameSync(dir, wreck);
      log.warn(`[db] damaged directory moved to ${wreck}`);
    } catch {
      // fall through: loadDataDir writes a fresh directory anyway
    }
    // loadDataDir needs a Blob (it calls .arrayBuffer()); a Buffer does not
    // have that method and fails with "e.arrayBuffer is not a function".
    const blob = new Blob([fs.readFileSync(snap)]);
    const client = new PGliteCtor(dir, { ...pgliteOptions(), loadDataDir: blob });
    await client.waitReady;
    return { client, recovered: true };
  }
}

/**
 * PGlite constructor options.
 *
 * relaxedDurability is left at its default (false) on purpose. The previous
 * value was `true`, which asks the filesystem layer to skip waiting for the
 * write to land: syncToFs() is then fire-and-forget rather than awaited, so a
 * close can return before the bytes are on disk. On Node the effect is small
 * (the Emscripten NODEFS backend writes straight through, and syncToFs is a
 * no-op there - measured at 0-1ms either way), but it buys nothing and the
 * strict path is the one whose guarantees are documented.
 *
 * Persistence tuning lives in SQL instead, below, because these are what
 * actually decide how much unflushed state a hard kill can cost.
 */
/**
 * PGlite constructor options.
 *
 * relaxedDurability is left at its default (false) on purpose, and the
 * constructor is called with NO options on the normal path. The previous
 * value was `relaxedDurability: true`, which asks the filesystem layer to
 * skip waiting for the write to land: syncToFs() is then fire-and-forget
 * rather than awaited, so a close can return before the bytes are on disk. On
 * Node the measured effect is nil (the Emscripten NODEFS backend writes
 * straight through and its syncToFs is a no-op - 0-1ms either way), but it
 * bought nothing and the strict path is the one whose guarantees are
 * documented.
 *
 * The only option actually passed is loadDataDir, and only on the recovery
 * path - see openPgliteWithRecovery.
 */
function pgliteOptions(): Record<string, unknown> {
  return {};
}

/**
 * The failure shapes an embedded Postgres produces when its data directory
 * cannot be replayed. Matched on the message because the errors surface from
 * WASM-compiled C with no codes, and the set is small and stable across
 * versions.
 */
function isCorruptionError(message: string): boolean {
  const needles = [
    "could not locate a valid checkpoint record",
    "invalid checkpoint record",
    "could not open file",
    "unexpected pageaddr",
    "incorrect checksum",
    "checksum verification failed",
    "database system was interrupted",
    "WAL segment required",
    "could not read from log segment",
    "Aborted(",
    "RuntimeError: unreachable",
  ];
  return needles.some((n) => message.includes(n));
}

/** A corruption the caller has to resolve by hand, with the exact options spelled out. */
function describeUnopenable(
  dir: string,
  message: string,
  hasSnapshot: boolean,
  forced: boolean,
): Error {
  const recovery = hasSnapshot
    ? ` A snapshot exists at ${snapshotPath(dir)} - start with OBOEXT_PGLITE_RECOVER=1 to restore it.`
    : " No snapshot exists, so there is nothing to restore from.";
  const force = forced ? "" : " (OBOEXT_PGLITE_RECOVER=1 was not set)";
  return new Error(
    `PGlite data directory ${dir} failed to open: ${message}${recovery}${force} ` +
      "To start from an empty database instead, move the directory aside and retry.",
  );
}

/**
 * A connection-level failure rather than a bad query. A cold serverless
 * Postgres (Neon, Supabase) drops the first TCP connection of a suspended
 * compute during the TLS handshake, and an immediate retry lands in the same
 * window - which is why a render-level "retry once" was not enough.
 */
export function isConnectionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("before secure TLS connection was established") ||
    msg.includes("socket hang up") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("connection terminated unexpectedly") ||
    msg.includes("Client has encountered a connection error") ||
    msg.includes("CONNECTION_CLOSED") ||
    msg.includes("connect ECONNREFUSED") ||
    // postgres.js surfaces a failed connect attempt as
    // `write CONNECT_TIMEOUT undefined:undefined` (the remoteAddress is
    // undefined because the socket never got past the handshake). This is the
    // exact "cold Neon compute / dead socket from a frozen lambda" symptom a
    // serverless Postgres produces — it MUST be retried, not thrown.
    msg.includes("CONNECT_TIMEOUT") ||
    // A *write* on a connection the server already closed surfaces as
    // `write CONNECTION_ENDED <host>:<port>`. Neon closes idle connections
    // whenever the compute suspends, so a pooled socket held across a warm/cold
    // boundary fails on the first write with this signature — a connection
    // error, not a query error. Without it here the retry never fires and one
    // suspended compute takes down every route it touches.
    msg.includes("CONNECTION_ENDED") ||
    // Same family, observed on a query in flight when the socket died.
    msg.includes("write CONNECTION_CLOSED") ||
    msg.includes("write ECONNRESET") ||
    // Neon cold-start: the auth/TLS handshake itself times out before the
    // connection is usable, surfaced as `PostgresError: Authentication timed
    // Out`.
    msg.toLowerCase().includes("timed out")
  );
}

/** Discard the pooled client so the next call opens a fresh connection. */
async function resetPostgresClient(): Promise<void> {
  try {
    if (postgresClient) await postgresClient.end({ timeout: 2 });
  } catch {
    // a client that cannot close cleanly is exactly the one being discarded
  }
  postgresClient = null;
  globalForDb.__oboeDb = undefined;
  globalForDb.__oboeReady = undefined;
  // __oboeMigrated MUST be cleared together with the instance.
  globalForDb.__oboeMigrated = undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolve (once) the lazily-created DB instance. */
export function ensureDb(): Promise<any> {
  if (!globalForDb.__oboeReady) {
    globalForDb.__oboeReady = (async () => {
      const attempts = Number(process.env.OBOEXT_DB_CONNECT_ATTEMPTS || 3);
      let last: unknown;
      for (let i = 0; i < attempts; i++) {
        try {
          const instance = await createDb();
          globalForDb.__oboeDb = instance;
          return instance;
        } catch (err) {
          last = err;
          if (!isConnectionError(err) || i === attempts - 1) throw err;
          const backoff = [0, 1500, 4000][i] ?? 4000;
          log.debug(`[db] connect attempt ${i + 1} failed, retrying in ${backoff}ms: ${(err as Error).message}`);
          await resetPostgresClient();
          await sleep(backoff);
        }
      }
      throw last;
    })().catch((err) => {
      globalForDb.__oboeReady = undefined;
      throw err;
    });
  }
  return globalForDb.__oboeReady;
}

/**
 * Run `fn`, and on a dropped connection rebuild the client once and repeat.
 * Retrying immediately is pointless while the server is still refusing
 * connections, so the second attempt waits out the wake-up window.
 */
export async function withDbRetry<T>(fn: () => Promise<T>): Promise<T> {
  const attempts = Number(process.env.OBOEXT_DB_QUERY_ATTEMPTS || 3);
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!isConnectionError(err) || i === attempts - 1) throw err;
      // Back off like ensureDb does. Neon needs more than a few hundred ms to
      // finish waking a suspended compute, so a single 500ms retry usually
      // lands inside the same refusal window and fails identically.
      const backoff = [0, 500, 1500][i] ?? 1500;
      log.warn(
        `[db] query attempt ${i + 1} failed, retrying in ${backoff}ms: ${(err as Error).message}`,
      );
      await resetPostgresClient();
      if (backoff) await sleep(backoff);
      await ensureDb();
    }
  }
  throw last;
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
    if (pgliteClient) {
      // checkpoint + snapshot before the close, not a bare close(): this is
      // the same teardown the signal path performs, and skipping the
      // checkpoint would drop whatever the WAL had not flushed - on a
      // driver swap the directory is being abandoned, so the last clean
      // state it ever has is this one.
      await pgliteClient.query("CHECKPOINT");
      await writeRecoverySnapshot(pgliteClient, snapshotPath(currentDataDir));
      await pgliteClient.close();
    }
  } catch {
    // ignore teardown errors — a fresh client is created regardless
  } finally {
    // The old hook still points at the client being closed here; drop it so
    // the next signal does not close the replacement.
    (globalThis as unknown as { __oboeDbUnregister?: () => void }).__oboeDbUnregister?.();
  }
  postgresClient = null;
  pgliteClient = null;
  currentDataDir = "";
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
/**
 * Parallel: one round trip per sequence is the whole cost of this function
 * (17 sequences measured at 4.7s serial against a hosted Postgres, ~0.3s
 * batched). postgres.js pipelines them onto the single pooled connection, so
 * this needs no larger pool to pay off.
 */
async function resyncSequences(): Promise<void> {
  const seqs = await rawQuery<{ sequencename: string }>(
    `select sequencename from pg_sequences where schemaname = 'public'`,
  );
  await Promise.all(
    seqs.map(async ({ sequencename }) => {
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
    }),
  );
}

/** Apply SQL migrations once per process; safe to await every request. */
export function ensureMigrations(): Promise<void> {
  if (!globalForDb.__oboeMigrated) {
    globalForDb.__oboeMigrated = (async () => {
      await ensureDb();
      const folder = path.resolve(process.cwd(), "db/migrations");
      await withDbRetry(async () => {
        if (postgresClient) {
          const drvPkg = "drizzle-orm/postgres" + "-js";
          const { migrate } = await import(drvPkg + "/migrator");
          const drvMod = await import(drvPkg);
          // Reuse the already-connected runtime pool for migrations instead of
          // opening a second connection: a cold Neon start pays one fewer TLS
          // handshake, and the pool (max>1) handles a single migration run
          // without issue. The runtime client was opened from the same validated
          // direct endpoint, so the session advisory locks migrations need are
          // satisfied identically.
          const migrateClient = postgresClient;
          logDbTarget("migrate (direct)", pickPostgresUrl());
          await migrate(drvMod.drizzle(migrateClient, { schema }), { migrationsFolder: folder });
        } else if (pgliteClient) {
          const drvPkg = "drizzle-orm/" + "pglite";
          const { migrate } = await import(drvPkg + "/migrator");
          await migrate(globalForDb.__oboeDb, { migrationsFolder: folder });
        }
      });
      // Best-effort and deliberately off the render path: renders only read,
      // so the first paint must not wait ~0.3s for a sequence resync. Drift
      // only exists after a manual import/restore, and the detached resync
      // finishes long before any real write can land. A failure here also no
      // longer fails the whole boot — it self-heals on the next one.
      withDbRetry(() => resyncSequences()).catch(() => {});
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
/**
 * The live drizzle instance, or a hard error if it is not ready.
 *
 * Every retry re-reads this instead of holding on to a captured instance: a
 * builder keeps a reference to the client that created it, so reusing one
 * across a reconnect re-sends the SQL to the *closed* pool and fails again
 * (`Cannot use a pool after calling end`). Reading it fresh per attempt is
 * what makes withDbRetry an actual retry.
 */
function currentDb(): any {
  const instance = globalForDb.__oboeDb;
  if (!instance) throw new Error("db used before ensureDb() resolved");
  return instance;
}

/**
 * Terminal operations on a query builder, retried on connection errors.
 *
 * `db.select().from(x).limit(1)` is lazy: nothing touches the socket until the
 * builder is awaited or `.execute()`-ed, and that is exactly where postgres.js
 * reports `write CONNECT_TIMEOUT` / `write CONNECTION_ENDED`. A cold serverless
 * Postgres (suspended Neon compute) or a dead socket left by a frozen lambda
 * both surface here, so these call sites go through withDbRetry.
 */
const TERMINAL_METHODS = new Set([
  "execute",
  "executeTakeFirst",
  "executeTakeFirstOrNull",
  "executeRaw",
  "all",
  "get",
  "getOrThrow",
  "values",
]);

function retryableBuilder(builder: any): any {
  if (!builder || typeof builder.then !== "function") return builder;
  return new Proxy(builder, {
    get(t, prop) {
      if (prop === "then") {
        return (resolve: any, reject: any) =>
          withDbRetry(() => t.then(resolve, reject));
      }
      if (typeof prop === "string" && TERMINAL_METHODS.has(prop)) {
        return (...a: any[]) => withDbRetry(() => t[prop](...a));
      }
      const v = Reflect.get(t, prop);
      if (typeof v === "function") {
        // keep chaining wrapped so a later `.then()` still retries
        return (...a: any[]) => retryableBuilder(v.apply(t, a));
      }
      return v;
    },
  });
}

export const db = new Proxy({} as Db, {
  get(_target, prop) {
    const val = Reflect.get(currentDb(), prop);
    if (typeof val === "function") {
      // `db.execute(sql)` returns an already-created Promise. Wrapping that
      // promise in a retry is a no-op — re-subscribing to a rejected promise
      // yields the same rejection — so eager methods are re-invoked against
      // the current instance on each attempt instead. Lazy builders (select /
      // insert / update / delete) build no promise until awaited and are safe
      // to defer to retryableBuilder.
      const eager = new Set([
        "execute",
        "executeRaw",
        "$with",
        "transaction",
      ]);
      if (eager.has(prop as string)) {
        return (...args: any[]) => withDbRetry(() => (currentDb() as any)[prop](...args));
      }
      return (...args: any[]) => retryableBuilder(val.apply(currentDb(), args));
    }
    return val;
  },
});

/** Driver-agnostic raw SQL with $1/$2 bindings. */
export async function rawQuery<T = Record<string, unknown>>(
  query: string,
  params: unknown[] = [],
): Promise<T[]> {
  await ensureDb();
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
  // currentDb() is read *inside* the retry closure: capturing the instance out
  // here would pin this call to the client that resetPostgresClient() is about
  // to close, making the retry re-send to a dead pool.
  const res: unknown = await withDbRetry(() => currentDb().execute(built));
  if (Array.isArray(res)) return res as T[];
  return ((res as { rows?: T[] }).rows ?? []) as T[];
}

export { schema };

/**
 * Boot-time warmup + render-readiness publication.
 *
 * ensureMigrations() is memoized on globalThis (one promise per process) and
 * idempotent; every later awaiter — the middleware, the rosefd framework's
 * render entry points — shares this very promise. Kicking it at module load
 * means PGlite opens, migrations apply and sequences resync while the server
 * is still starting, instead of the first request paying the whole cold path.
 * The sequence resync detaches from this gate: renders only read and must not
 * wait for it.
 *
 * The framework's render functions (renderPage / renderPageStream) await
 * globalThis.__rosefdAppReady before painting a page, so a cold-start render
 * never reads $data() against an unconnected db proxy and ships a blank
 * document. Publishing the same promise here is what wires that gate to this
 * app's database. Apps without a database simply never set this global, and
 * the gate is skipped (no behavioral change). The detached catch only
 * prevents an unused-promise unhandled rejection; the memoized promise keeps
 * its error for the framework's real await, and a failed warmup self-clears
 * so the next request retries.
 */
// A build imports this module (prerender / route analysis import
// dist/server.js) purely to inspect routes and render static pages - it must
// NOT open the production database. The rosefd build entry sets
// ROSEFD_BUILDING=1; under it the eager warmup is replaced by an already-resolved
// promise so nothing here reaches for a connection. The runtime server (dev,
// preview, prod) never sets the flag and keeps the eager warmup below, so the
// fast cold start is unchanged. Without this guard a CI/Vercel build blocks on
// the live database and can be killed before tools/build.mjs mirrors the
// deploy-root public/ tree - the static layer then ships with no app JS and
// every page sticks on its loading frame.
const __rosefdAppReady =
  process.env.ROSEFD_BUILDING === "1" ? Promise.resolve() : ensureMigrations();
globalForDb.__rosefdAppReady = __rosefdAppReady;
void __rosefdAppReady.catch(() => {});
