import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { buildDatabaseBackup, restoreDatabaseBackup } from "./backup.js";
import { UPLOADS_DIR } from "./storage.js";
import { unzip } from "./package-install.js";

// R353: the database-only backup could never rebuild a site on a fresh
// machine — `media` rows point at /uploads/... files the JSON never carried.
// The full backup is a STORE-only zip (uploads are already-compressed
// binaries; no deflate pass) of `database.json` plus every file under
// content/uploads/, and the restore writes the files back with the same
// traversal guard the media pipeline uses.
//
// Entry names are fixed and flat-rooted: `database.json` and `uploads/<rel>`
// — the reader only accepts those two shapes.

const LOCAL_SIG = 0x04034b50;
const CD_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const FLAG_UTF8 = 0x800;

/** The largest unzipped full backup the restore will buffer (bytes). */
export const MAX_FULL_BACKUP_BYTES = 256 * 1024 * 1024;

function dosStamp(d: Date): { time: number; date: number } {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** Minimal STORE-only zip writer — enough for our own backup reader. */
export function zipStore(entries: { name: string; data: Buffer }[]): Buffer {
  const stamp = dosStamp(new Date());
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const crc = zlib.crc32(e.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, e.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CD_SIG, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + e.data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function walkUploads(root: string, rel = ""): { name: string; data: Buffer }[] {
  const out: { name: string; data: Buffer }[] = [];
  const dir = path.join(root, rel);
  let items: fs.Dirent[];
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // no uploads directory: an empty set, not an error
  }
  for (const it of items) {
    const childRel = rel ? rel + "/" + it.name : it.name;
    if (it.isDirectory()) out.push(...walkUploads(root, childRel));
    else if (it.isFile()) {
      out.push({ name: "uploads/" + childRel, data: fs.readFileSync(path.join(root, childRel)) });
    }
  }
  return out;
}

/** `database.json` + every upload file, as one zip. */
export async function buildFullBackupZip(): Promise<Buffer> {
  const db = await buildDatabaseBackup();
  const entries = [
    { name: "database.json", data: Buffer.from(JSON.stringify(db), "utf8") },
    ...walkUploads(UPLOADS_DIR),
  ];
  return zipStore(entries);
}

/**
 * Restore a full backup: `database.json` goes through the same
 * restoreDatabaseBackup the JSON path uses; every `uploads/` entry is written
 * back under content/uploads. Entry names outside those two shapes are
 * REFUSED (a zip from elsewhere must not drop files anywhere else), and the
 * resolved path must stay inside UPLOADS_DIR — the same guard storage.ts
 * applies to media writes.
 */
export async function restoreFullBackupZip(
  buf: Buffer,
): Promise<{ restored: Record<string, number>; files: number }> {
  const entries = unzip(buf, { maxTotalBytes: MAX_FULL_BACKUP_BYTES });
  const dbEntry = entries.find((e) => e.name === "database.json");
  if (!dbEntry) throw new Error("备份缺少 database.json");
  const parsed = JSON.parse(dbEntry.data.toString("utf8"));
  const result = await restoreDatabaseBackup(parsed);
  const root = path.resolve(UPLOADS_DIR);
  let files = 0;
  for (const e of entries) {
    if (!e.name.startsWith("uploads/")) continue;
    const rel = e.name.slice("uploads/".length);
    if (!rel || rel.includes("..") || path.isAbsolute(rel)) continue;
    const target = path.resolve(root, rel);
    if (!target.startsWith(root + path.sep)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, e.data);
    files++;
  }
  return { restored: result.restored, files };
}
