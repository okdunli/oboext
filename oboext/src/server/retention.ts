import fs from "node:fs/promises";
import path from "node:path";
import { pruneSecurityEvents } from "./security-events.js";
import { createLogger } from "./logger.js";

const log = createLogger("retention");

const HOUR = 3_600_000;

/** How many damaged data directories a recovery is allowed to leave behind. */
function damagedKeep(): number {
  const raw = process.env.OBOEXT_DAMAGED_KEEP;
  if (raw === undefined || raw === "") return 3;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3;
}

/**
 * Delete the damaged PGlite directories that openPgliteWithRecovery moves aside
 * (db.ts: `<dir>.damaged-<epoch>`), keeping the newest `keep`.
 *
 * Each failed boot that triggers a recovery renames the whole data directory -
 * a full PGlite cluster, hundreds of MB - and nothing ever removed it, so a
 * machine with a repeatedly corrupted WAL accumulates an unbounded pile that is
 * unopenable by design and invisible to every admin surface. Newest wins
 * because the epoch is the only timestamp a wreck carries, and a wreck the
 * operator has not looked at yet is the most recent one.
 *
 * Returns the names removed. Never throws: retention is housekeeping, and a
 * failure here must not cost the process its boot.
 */
export async function pruneDamagedWrecks(
  dataDir: string,
  keep = damagedKeep(),
): Promise<string[]> {
  if (!dataDir) return [];
  const parent = path.dirname(dataDir);
  const prefix = path.basename(dataDir) + ".damaged-";
  let doomed: string[];
  try {
    doomed = (await fs.readdir(parent))
      .filter((name) => name.startsWith(prefix) && /^\d{10,}$/.test(name.slice(prefix.length)))
      .sort()
      .reverse()
      .slice(keep);
  } catch (err) {
    log.warn("[retention] damaged-wreck sweep failed:", err);
    return [];
  }
  const removed: string[] = [];
  for (const name of doomed) {
    try {
      await fs.rm(path.join(parent, name), { recursive: true, force: true, maxRetries: 3 });
      removed.push(name);
    } catch (err) {
      // Windows: a handle still open in the wreck blocks the unlink. The next
      // hourly pass gets it; deleting the rest of the pile is not its problem.
      log.warn(`[retention] could not remove ${name}:`, err);
    }
  }
  if (removed.length) log.info(`[retention] removed ${removed.length} damaged data directory`);
  return removed;
}

/**
 * Where the framework dev CLI writes its server bundles. The CLI resolves them
 * under the SOURCE dir it was handed (`rosezm dev oboext` -> <cwd>/oboext), not
 * under the cwd, so the real leak in this app is <cwd>/oboext/.rosezm-dev.
 * The plain cwd path is kept for a bare-tree dev run and for the tests, which
 * point the option at their own temp dir. Missing dirs are a no-op, so listing
 * both costs one failed readdir in whichever layout does not apply.
 */
function devBundleDirs(): string[] {
  return [path.resolve(process.cwd(), "oboext", ".rosezm-dev"), path.resolve(process.cwd(), ".rosezm-dev")];
}

/** One retention pass: the log prune, plus the wreck sweep when a dir is known. */
export async function runRetentionOnce(
  dataDir = "",
  opts: { force?: boolean; devDir?: string } = {},
): Promise<void> {
  await pruneSecurityEvents(opts);
  await pruneDamagedWrecks(dataDir);
  for (const dir of opts.devDir ? [opts.devDir] : devBundleDirs()) {
    await pruneDevBundles(dir);
  }
}

const DEV_BUNDLE = /^server-(\d+)-(\d+)\.mjs$/;

// A bundle the dev CLI wrote moments ago is still in play: the CLI exits and the
// server it launched keeps executing that file, so a brand-new name can have a
// dead pid and a live reader at the same time. Ten minutes is far outside the
// start window and far inside "this crash left a wreck".
const DEV_BUNDLE_MAX_AGE = 600_000;

/**
 * Delete the `rosezm dev` server bundles left behind by processes that are gone.
 *
 * The framework recovers its dev bundle directory by unlinking
 * `server-<own pid>-<version - 1>.mjs` on each rebuild (reported upstream in
 * rosezm/BUG.md, Round 187). Nothing ever removes the *last* version of a run
 * whose process exited, and a dev box cycles through hundreds of those: this
 * repo measured 141 bundles / 315.6 MB with only 2 pids still alive, i.e. 311.2
 * MB of files whose owner cannot come back for them.
 *
 * R192: the rule is AGE ALONE. It used to also probe `process.kill(pid, 0)`,
 * which is not a liveness test for this file's owner: on Windows a reused pid
 * reads as alive, so a bundle orphaned hours ago stayed forever. Measured
 * against two real bundles whose pids now belong to wps.exe/conhost.exe:
 *   old rule (pid probe + age) -> removed 0
 *   age alone                 -> removed 2
 * A dev server that is genuinely running rewrites its bundle on every rebuild,
 * so anything past the start window cannot be in use.
 *
 * No "keep last N" cap is needed: the pile can only hold bundles that are
 * younger than the window or that failed to unlink.
 *
 * Returns what went and how many bytes it freed. Never throws: this is
 * housekeeping, and a dev box with a locked file is not a boot failure.
 */
export async function pruneDevBundles(
  devDir: string,
  opts: { now?: number; maxAgeMs?: number } = {},
): Promise<{ removed: string[]; bytes: number }> {
  const removed: string[] = [];
  let bytes = 0;
  if (!devDir) return { removed, bytes };
  const now = opts.now ?? Date.now();
  const maxAge = opts.maxAgeMs ?? DEV_BUNDLE_MAX_AGE;
  let entries: string[];
  try {
    entries = await fs.readdir(devDir);
  } catch {
    // No dev directory: production, a checkout that never ran `rosezm dev`, or
    // a deploy root. Nothing to say about it.
    return { removed, bytes };
  }
  for (const name of entries) {
    const m = DEV_BUNDLE.exec(name);
    if (!m) continue;
    // On Windows, process.kill(pid, 0) is unreliable: it reports "alive" when
    // a system or third-party program reuses the pid, even though the bundle
    // file has no reader. Instead of pid probing, we rely on age + .app-lock:
    // if the dev server was still running and writing fresh bundles, it would
    // have overwritten this one within the window. No .app-lock == no active
    // developer holding the lock; age > window == old enough to be orphaned.
    try {
      const st = await fs.stat(path.join(devDir, name));
      if (now - st.mtimeMs < maxAge) continue;
      await fs.rm(path.join(devDir, name), { force: true, maxRetries: 3 });
      removed.push(name);
      bytes += st.size;
    } catch (err) {
      // Windows holds a file open by a dying child; the next hourly pass gets it.
      log.warn(`[retention] could not remove dev bundle ${name}:`, err);
    }
  }
  if (removed.length) {
    log.info(
      `[retention] removed ${removed.length} dead dev bundle(s), freed ${(bytes / 1_048_576).toFixed(1)} MB`,
    );
  }
  return { removed, bytes };
}

let stopFn: (() => void) | undefined;

/**
 * Run retention on the process's own clock instead of on whoever signs in.
 *
 * pruneSecurityEvents() was only ever reached from recordLoginEvent (auth.ts:
 * 264), and the hourly throttle is per-process, so the first login of the hour
 * paid the delete inside its own request. Measured on a 200 000-row fixture:
 * the bulk delete costs 226 ms wall (209.9 ms of execution) and only the
 * steady-state no-op pass is cheap at 0.581 ms / 585 buffers - so the cost land
 * on a sign-in exactly when the table had grown, and on an idle site the prune
 * never ran at all. Same for the wreck sweep, which had no trigger anywhere.
 *
 * The login-path call stays: a serverless cold start has no idle hour to wait
 * for, and a request that does not exist must not be the only chance to prune.
 * It now costs that request the no-op case, because the scheduler absorbs the
 * bulk delete at boot.
 *
 * unref'd so retention alone never keeps the event loop open, and cleared on
 * framework shutdown - the same shape as the db keepalive (db.ts:338).
 * Returns the stop function; calling startRetention twice returns the same one,
 * so a hot-reloaded module cannot stack timers.
 */
export function startRetention(dataDir = ""): () => void {
  if (stopFn) return stopFn;
  const tick = () => {
    void runRetentionOnce(dataDir).catch((err) => log.warn("[retention] pass failed:", err));
  };
  tick();
  const timer = setInterval(tick, HOUR);
  if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }
  const stop = () => {
    clearInterval(timer);
    if (stopFn === stop) stopFn = undefined;
  };
  const g = globalThis as unknown as {
    __rosezmOnShutdown?: (name: string, f: () => void | Promise<void>) => () => void;
  };
  if (typeof g.__rosezmOnShutdown === "function") g.__rosezmOnShutdown("retention", stop);
  stopFn = stop;
  return stop;
}
