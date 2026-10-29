import { getOption, setOption } from "./options.js";
import { getPermalinkConfig } from "./links.js";
import { ServiceError } from "./errors.js";
import { invalidateContentCaches } from "./cache.js";

export type CaptchaMode = "builtin" | "custom";
export type CaptchaVerifyMethod = "POST" | "GET" | "PUT";

export interface AdminSecurity {

  entryEnabled: boolean;

  entryPath: string;

  captchaEnabled: boolean;

  captchaMode: CaptchaMode;

  captchaVerifyUrl: string;
  captchaVerifyMethod: CaptchaVerifyMethod;

  captchaVerifyHeaders: string;

  captchaVerifyBody: string;

  captchaVerifySuccess: string;

  throttleEnabled: boolean;
  throttleMaxFailures: number;

  throttleWindowMinutes: number;
}

const OPTION_KEY = "adminSecurity";

const DEFAULT_SECURITY: AdminSecurity = {
  entryEnabled: false,
  entryPath: "/secret-login",
  captchaEnabled: false,
  captchaMode: "builtin",
  captchaVerifyUrl: "",
  captchaVerifyMethod: "POST",
  captchaVerifyHeaders: "",

  captchaVerifyBody: '{"token":"{{token}}"}',
  captchaVerifySuccess: "",
  throttleEnabled: true,
  throttleMaxFailures: 5,
  throttleWindowMinutes: 15,
};

const RESERVED_SEGMENTS = new Set([
  "admin",
  "api",
  "search",
  "archives",
  // Public .rose routes: an admin-configured register/entry path on one of
  // these would be shadowed by the real page (resolveInner claims the segment
  // before it ever looks at the configured path), so they are refused instead.
  "newsletter",
  "feed.xml",
  "sitemap.xml",
  "robots.txt",
  "favicon.ico",
  "theme-assets",
  "theme-style",
  "plugin-assets",
  "uploads",
  "static",
  "manifest.json",
  "manifest.webmanifest",
]);

const ENTRY_PATH_RE = /^\/[a-z0-9][a-z0-9-_/]*$/;

export async function normalizePublicPath(raw: string): Promise<string> {
  const path = raw
    .trim()
    .replace(/^\/+/, "/")
    .replace(/\/+$/, "")
    .replace(/\/{2,}/g, "/")
    .toLowerCase();
  if (!ENTRY_PATH_RE.test(path)) {
    throw new ServiceError(
      "路径只能包含字母、数字、-、_、/，需以 / 开头且不以 / 结尾",
      422,
    );
  }
  if (path.length > 64) throw new ServiceError("路径过长（最多 64 个字符）", 422);
  const segments = path.split("/").filter(Boolean);
  if (segments.length > 3) throw new ServiceError("路径最多 3 层目录", 422);
  const first = segments[0];
  if (RESERVED_SEGMENTS.has(first)) {
    throw new ServiceError(`/${first} 是系统保留路径，请更换`, 422);
  }
  const permalink = await getPermalinkConfig();
  for (const base of [
    permalink.postBase,
    permalink.pageBase,
    permalink.categoryBase,
    permalink.tagBase,
  ]) {
    const seg = base.split("/").filter(Boolean)[0];
    if (seg && seg === first) {
      throw new ServiceError(`路径与固定链接前缀 /${base} 冲突，请更换`, 422);
    }
  }
  return path;
}

export async function getAdminSecurity(): Promise<AdminSecurity> {
  const stored = (await getOption<Partial<AdminSecurity>>(OPTION_KEY, {})) ?? {};
  return { ...DEFAULT_SECURITY, ...stored };
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampText(raw: unknown, fallback: string, max: number, label: string): string {
  if (typeof raw !== "string") return fallback;
  const s = raw.trim();
  if (s.length > max) throw new ServiceError(`${label}过长（最多 ${max} 个字符）`, 422);
  return s;
}

export async function saveAdminSecurity(
  input: Partial<AdminSecurity>,
): Promise<AdminSecurity> {
  const current = await getAdminSecurity();
  const next: AdminSecurity = {
    entryEnabled:
      typeof input.entryEnabled === "boolean" ? input.entryEnabled : current.entryEnabled,
    entryPath:
      typeof input.entryPath === "string" ? input.entryPath : current.entryPath,
    captchaEnabled:
      typeof input.captchaEnabled === "boolean"
        ? input.captchaEnabled
        : current.captchaEnabled,
    captchaMode:
      input.captchaMode === "builtin" || input.captchaMode === "custom"
        ? input.captchaMode
        : current.captchaMode,
    captchaVerifyUrl:
      typeof input.captchaVerifyUrl === "string"
        ? input.captchaVerifyUrl.trim()
        : current.captchaVerifyUrl,
    captchaVerifyMethod:
      input.captchaVerifyMethod === "POST" ||
      input.captchaVerifyMethod === "GET" ||
      input.captchaVerifyMethod === "PUT"
        ? input.captchaVerifyMethod
        : current.captchaVerifyMethod,
    captchaVerifyHeaders: clampText(
      input.captchaVerifyHeaders,
      current.captchaVerifyHeaders,
      2000,
      "验证码请求头",
    ),
    captchaVerifyBody: clampText(
      input.captchaVerifyBody,
      current.captchaVerifyBody,
      2000,
      "验证码请求体模板",
    ),
    captchaVerifySuccess: clampText(
      input.captchaVerifySuccess,
      current.captchaVerifySuccess,
      100,
      "验证码成功判定规则",
    ),
    throttleEnabled:
      typeof input.throttleEnabled === "boolean"
        ? input.throttleEnabled
        : current.throttleEnabled,
    throttleMaxFailures: clampInt(
      input.throttleMaxFailures,
      current.throttleMaxFailures,
      3,
      50,
    ),
    throttleWindowMinutes: clampInt(
      input.throttleWindowMinutes,
      current.throttleWindowMinutes,
      1,
      1440,
    ),
  };

  if (next.captchaMode === "builtin") {
    next.captchaVerifyUrl = "";
    next.captchaVerifyHeaders = "";
    next.captchaVerifyBody = DEFAULT_SECURITY.captchaVerifyBody;
    next.captchaVerifySuccess = "";
  }

  next.entryPath = await normalizePublicPath(next.entryPath);

  if (next.captchaEnabled && next.captchaMode === "custom") {
    if (!next.captchaVerifyUrl) {
      throw new ServiceError("请填写验证码校验接口地址", 422);
    }

    const renderedUrl = next.captchaVerifyUrl.replace(/\{\{\s*token\s*\}\}/g, "x");
    let u: URL;
    try {
      u = new URL(renderedUrl);
    } catch {
      throw new ServiceError("验证码校验接口地址不是合法 URL", 422);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new ServiceError("校验接口只支持 http / https 地址", 422);
    }
    if (next.captchaVerifyUrl.length > 255) {
      throw new ServiceError("验证码校验接口地址过长（最多 255 个字符）", 422);
    }

    if (next.captchaVerifyHeaders.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(next.captchaVerifyHeaders) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("not-object");
        }
      } catch {
        throw new ServiceError("验证码请求头 JSON 格式不正确", 422);
      }
    }

    if (next.captchaVerifySuccess && !next.captchaVerifySuccess.includes("=")) {
      throw new ServiceError("成功判定规则格式应为 code=200 这样的 路径=值", 422);
    }
  }

  await setOption(OPTION_KEY, next);
  // The secret-entry path is a catch-all fallback view: a URL that 404'd a
  // minute ago is memoized as a miss for 60s, so enabling the entry (or
  // moving its path) must drop those flags or the new login door stays
  // unreachable until the TTL expires. Same contract the content write
  // paths already honour.
  invalidateContentCaches();
  return next;
}

export function isEntryReferer(req: Request, sec: AdminSecurity): boolean {
  if (!sec.entryEnabled) return true;
  let pathname = "";
  try {
    pathname = new URL(req.headers.get("referer") ?? "").pathname;
  } catch {
    pathname = "";
  }
  return pathname === sec.entryPath;
}
