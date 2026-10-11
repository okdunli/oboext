import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";
import { ServiceError } from "./admin.js";
import { rmSyncRetry } from "./fs-utils.js";

export type PackageKind = "theme" | "plugin";

export const MAX_ZIP_BYTES = 30 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 80 * 1024 * 1024;
const MAX_ENTRIES = 2000;

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

interface ZipEntry {

  name: string;
  data: Buffer;
}

function u16(b: Buffer, o: number): number {
  return b.readUInt16LE(o);
}
function u32(b: Buffer, o: number): number {
  return b.readUInt32LE(o);
}

function decodeName(raw: Buffer, flags: number): string {
  if (flags & 0x800) return raw.toString("utf8");
  try {
    return new TextDecoder("gbk").decode(raw);
  } catch {
    return raw.toString("latin1");
  }
}

export function unzip(buf: Buffer): ZipEntry[] {

  let eocd = -1;
  const scanStart = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= scanStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ServiceError("不是有效的 ZIP 文件（找不到中央目录）", 422);

  const total = u16(buf, eocd + 10);
  const cdSize = u32(buf, eocd + 12);
  const cdOffset = u32(buf, eocd + 16);
  if (cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ServiceError("暂不支持 ZIP64 格式的压缩包", 422);
  }
  if (cdOffset + cdSize > buf.length) {
    throw new ServiceError("ZIP 中央目录已损坏", 422);
  }

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (u32(buf, p) !== CD_SIG) {
      throw new ServiceError("ZIP 中央目录已损坏", 422);
    }
    const flags = u16(buf, p + 8);
    const method = u16(buf, p + 10);
    const compSize = u32(buf, p + 20);
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commentLen = u16(buf, p + 32);
    const localOffset = u32(buf, p + 42);
    const name = decodeName(buf.subarray(p + 46, p + 46 + nameLen), flags);
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue;
    if (entries.length >= MAX_ENTRIES) {
      throw new ServiceError("压缩包内文件数量超出上限", 422);
    }

    if (u32(buf, localOffset) !== LOCAL_SIG) {
      throw new ServiceError("ZIP 本地文件头已损坏", 422);
    }
    const localNameLen = u16(buf, localOffset + 26);
    const localExtraLen = u16(buf, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compSize > buf.length) {
      throw new ServiceError("ZIP 数据区已损坏", 422);
    }
    const raw = buf.subarray(dataStart, dataStart + compSize);

    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(raw);
    } else if (method === 8) {
      try {
        data = zlib.inflateRawSync(raw, { maxOutputLength: MAX_UNPACKED_BYTES });
      } catch {
        throw new ServiceError(`文件「${name}」解压失败，压缩数据已损坏`, 422);
      }
    } else {
      throw new ServiceError(`暂不支持的压缩方式（method=${method}），请用标准 deflate 重新打包`, 422);
    }
    entries.push({ name: normalizeZipPath(name), data });
  }
  if (entries.length === 0) throw new ServiceError("压缩包是空的", 422);
  return entries;
}

function normalizeZipPath(name: string): string {
  const s0 = name.replace(/\\/g, "/").replace(/^[a-zA-Z]:/, "").replace(/^\/+/, "");
  const segs = s0.split("/").filter((seg) => seg.length && seg !== ".");
  if (segs.some((seg) => seg === "..")) {
    throw new ServiceError("压缩包含非法路径（.. 跳转），已拒绝安装", 422);
  }
  const s = segs.join("/");
  if (!s) throw new ServiceError("压缩包内含空文件名条目", 422);
  return s;
}

function stripWrapper(entries: ZipEntry[]): { root: ZipEntry[]; wrapper: string | null } {
  const clean = entries.filter(
    (e) => !e.name.startsWith("__MACOSX/") && e.name !== ".DS_Store",
  );
  if (clean.length === 0) {
    throw new ServiceError("压缩包只包含系统垃圾文件（__MACOSX/.DS_Store）", 422);
  }
  const tops = new Set(clean.map((e) => e.name.split("/")[0]));
  if (tops.size === 1) {
    const wrapper = [...tops][0];
    const root = clean
      .map((e) => ({ name: e.name.slice(wrapper.length + 1), data: e.data }))
      .filter((e) => e.name);
    if (root.length) return { root, wrapper };
  }
  return { root: clean, wrapper: null };
}

const SLUG_RE = /^[a-z0-9][a-z0-9-_]{0,59}$/;

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9一-龥]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || ""
  );
}

const THEME_ENTRY = ["index.ts", "index.tsx"];
const PLUGIN_ENTRY = ["index.ts", "index.tsx", "index.js", "index.mjs"];

export interface InstalledPackage {
  kind: PackageKind;
  slug: string;
  name: string;
}

export function installPackage(kind: PackageKind, buf: Buffer): InstalledPackage {
  if (!buf || buf.length < 22) throw new ServiceError("文件内容不是有效的 ZIP", 422);
  if (buf.length > MAX_ZIP_BYTES) {
    throw new ServiceError(`安装包不能超过 ${Math.round(MAX_ZIP_BYTES / 1024 / 1024)}MB`, 422);
  }

  const entries = unzip(buf);
  const unpacked = entries.reduce((sum, e) => sum + e.data.length, 0);
  if (unpacked > MAX_UNPACKED_BYTES) {
    throw new ServiceError("解压后体积超出上限，请精简安装包", 422);
  }
  const { root, wrapper } = stripWrapper(entries);

  const manifestName = kind === "theme" ? "manifest.json" : "plugin.json";
  const manifestEntry = root.find((e) => e.name === manifestName);
  if (!manifestEntry) {
    throw new ServiceError(
      kind === "theme"
        ? "不是合规的主题包：根目录缺少 manifest.json"
        : "不是合规的插件包：根目录缺少 plugin.json",
      422,
    );
  }

  let manifest: { name?: unknown; slug?: unknown };
  try {
    manifest = JSON.parse(manifestEntry.data.toString("utf8"));
  } catch {
    throw new ServiceError(`${manifestName} 不是合法的 JSON`, 422);
  }
  if (typeof manifest.name !== "string" || !manifest.name.trim()) {
    throw new ServiceError(`${manifestName} 缺少有效的 name 字段`, 422);
  }
  const entryCandidates = kind === "theme" ? THEME_ENTRY : PLUGIN_ENTRY;
  const hasEntry = root.some((e) => entryCandidates.includes(e.name));
  if (!hasEntry) {
    throw new ServiceError(
      kind === "theme"
        ? "不是合规的主题包：缺少入口文件 index.ts（或 index.tsx）"
        : "不是合规的插件包：缺少入口文件 index.ts / index.js",
      422,
    );
  }

  let slug = wrapper || (typeof manifest.slug === "string" ? manifest.slug : "") || slugify(manifest.name);
  slug = slug.toLowerCase();
  if (!SLUG_RE.test(slug)) {
    throw new ServiceError(
      `目录标识「${slug}」不合法，仅允许字母、数字、连字符且以字母数字开头`,
      422,
    );
  }

  const dest = path.join(process.cwd(), kind === "theme" ? "themes" : "plugins", slug);
  if (fs.existsSync(dest)) {
    throw new ServiceError(
      `${kind === "theme" ? "主题" : "插件"}「${slug}」已存在，请勿重复安装`,
      422,
    );
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `oboe-${kind}-`));
  try {
    for (const e of root) {

      const target = path.resolve(tmp, e.name);
      if (target !== path.resolve(tmp) && !target.startsWith(path.resolve(tmp) + path.sep)) {
        throw new ServiceError("压缩包含非法路径，已拒绝安装", 422);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, e.data);
    }

    try {
      fs.renameSync(tmp, dest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      fs.cpSync(tmp, dest, { recursive: true });
      rmSyncRetry(tmp);
    }
  } catch (e) {

    rmSyncRetry(tmp);
    if (fs.existsSync(dest)) rmSyncRetry(dest);
    throw e;
  }

  return { kind, slug, name: manifest.name.trim() };
}
