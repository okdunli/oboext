/**
 * Installer database/storage configuration — ported from
 * app/api/db-config/route.ts. Writes .env.local (merged, unrelated lines
 * preserved), applies the choice to the running process, and migrates the
 * new target before /api/setup creates the first admin.
 */
import fs from "fs";
import path from "path";
import { ensureMigrations, reconfigureDatabase } from "./db.js";
import { ServiceError } from "./admin.js";

const ENV_CONFIG = path.resolve(process.cwd(), ".env.local");

async function verifyPostgres(url: string): Promise<string | null> {
  const postgres = (await import("post" + "gres")).default;
  const client = postgres(url, { max: 1, connect_timeout: 5 });
  try {
    await client`select version()`;
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    await client.end({ timeout: 2 });
  }
}

/** Merge key=value entries into .env.local, preserving unrelated lines. */
function writeEnvLocal(entries: Record<string, string>): void {
  const lines = fs.existsSync(ENV_CONFIG)
    ? fs.readFileSync(ENV_CONFIG, "utf8").split(/\r?\n/)
    : [];
  for (const [key, val] of Object.entries(entries)) {
    const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=`);
    const found = lines.findIndex((l) => re.test(l));
    if (found >= 0) lines[found] = `${key}=${val}`;
    else lines.push(`${key}=${val}`);
  }
  fs.mkdirSync(path.dirname(ENV_CONFIG), { recursive: true });
  fs.writeFileSync(
    ENV_CONFIG,
    lines.filter((l) => l.trim() !== "").join("\n") + "\n",
    "utf8",
  );
}

export async function applyDbConfig(input: {
  driver?: unknown;
  url?: unknown;
  storage?: unknown;
  blobToken?: unknown;
}): Promise<{ driver: "pglite" | "postgres"; storage: "local" | "vercel-blob" }> {
  const driver: "pglite" | "postgres" = input.driver === "postgres" ? "postgres" : "pglite";
  const url = typeof input.url === "string" ? input.url.trim() : "";
  const storage: "local" | "vercel-blob" =
    input.storage === "vercel-blob" ? "vercel-blob" : "local";
  const blobToken = typeof input.blobToken === "string" ? input.blobToken.trim() : "";

  if (driver === "postgres") {
    if (!url) throw new ServiceError("postgres 驱动需要提供连接串 DATABASE_URL", 422);
    const err = await verifyPostgres(url);
    if (err) throw new ServiceError(`无法连接远程数据库：${err}`, 400);
  }
  if (storage === "vercel-blob" && !blobToken) {
    throw new ServiceError("选择 Vercel Blob 需要填写 BLOB_READ_WRITE_TOKEN", 422);
  }

  const entries: Record<string, string> = {
    DB_DRIVER: driver,
    DATABASE_URL: driver === "postgres" ? url : "./.data/pglite_live",
    BLOB_READ_WRITE_TOKEN: storage === "vercel-blob" ? blobToken : "",
  };
  const alreadyProvided =
    process.env.DB_DRIVER === driver &&
    (driver !== "postgres" || process.env.DATABASE_URL === url) &&
    (storage !== "vercel-blob" || process.env.BLOB_READ_WRITE_TOKEN === blobToken);
  if (!alreadyProvided) writeEnvLocal(entries);

  const current = (process.env.DB_DRIVER || "pglite") as "pglite" | "postgres";
  if (driver !== current) {
    await reconfigureDatabase(
      driver,
      driver === "postgres" ? url : "./.data/pglite_live",
    );
    await ensureMigrations();
  }

  if (storage === "vercel-blob") process.env.BLOB_READ_WRITE_TOKEN = blobToken;
  else delete process.env.BLOB_READ_WRITE_TOKEN;

  return { driver, storage };
}
