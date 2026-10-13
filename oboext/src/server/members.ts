

import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { db, ensureMigrations } from "./db.js";
import { users } from "./schema.js";
import type { Role } from "./schema.js";
import { hashPassword } from "./auth.js";
import type { SessionUser } from "./auth.js";
import { normalizeContactTarget } from "./auth.js";
import { getOption, setOption } from "./options.js";
import { getNotifySettings } from "./notify.js";
import { verifyCode } from "./verify-codes.js";
import { getPermalinkConfig } from "./links.js";
import { addPasswordlessMark } from "./passwordless.js";
import { ServiceError } from "./errors.js";

const OPTION_KEY = "memberSettings";

export type MemberDefaultRole = Extract<Role, "subscriber" | "author">;

export interface MemberSettings {

  registerEnabled: boolean;

  registerPath: string;
  nameRequired: boolean;
  passwordRequired: boolean;
  emailRequired: boolean;
  phoneRequired: boolean;

  captchaEnabled: boolean;
  inviteOnly: boolean;
  inviteCodes: string[];
  defaultRole: MemberDefaultRole;
}

const DEFAULT_SETTINGS: MemberSettings = {
  registerEnabled: false,
  registerPath: "/user",
  nameRequired: true,
  passwordRequired: true,
  emailRequired: true,
  phoneRequired: false,
  captchaEnabled: false,
  inviteOnly: false,
  inviteCodes: [],
  defaultRole: "subscriber",
};

export async function getMemberSettings(): Promise<MemberSettings> {
  const stored = (await getOption<Partial<MemberSettings>>(OPTION_KEY, {})) ?? {};
  return { ...DEFAULT_SETTINGS, ...stored };
}

const RESERVED_SEGMENTS = new Set([
  "admin",
  "api",
  "search",
  "archives",
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

export async function normalizeRegisterPath(raw: string): Promise<string> {
  const path = raw
    .trim()
    .replace(/^\/+/, "/")
    .replace(/\/+$/, "")
    .replace(/\/{2,}/g, "/")
    .toLowerCase();
  if (!ENTRY_PATH_RE.test(path)) {
    throw new ServiceError("路径只能包含字母、数字、-、_、/，需以 / 开头且不以 / 结尾", 422);
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

export async function saveMemberSettings(
  input: Partial<MemberSettings>,
): Promise<MemberSettings> {
  const current = await getMemberSettings();
  const bool = (v: unknown, cur: boolean) => (typeof v === "boolean" ? v : cur);
  const next: MemberSettings = {
    registerEnabled: bool(input.registerEnabled, current.registerEnabled),
    registerPath:
      typeof input.registerPath === "string" ? input.registerPath : current.registerPath,
    nameRequired: bool(input.nameRequired, current.nameRequired),
    passwordRequired: bool(input.passwordRequired, current.passwordRequired),
    emailRequired: bool(input.emailRequired, current.emailRequired),
    phoneRequired: bool(input.phoneRequired, current.phoneRequired),
    captchaEnabled: bool(input.captchaEnabled, current.captchaEnabled),
    inviteOnly: bool(input.inviteOnly, current.inviteOnly),

    inviteCodes: Array.isArray(input.inviteCodes)
      ? [
          ...new Set(
            input.inviteCodes
              .map((c) => String(c).trim())
              .filter((c) => c.length > 0 && c.length <= 64),
          ),
        ].slice(0, 200)
      : current.inviteCodes,
    defaultRole:
      input.defaultRole === "subscriber" || input.defaultRole === "author"
        ? input.defaultRole
        : current.defaultRole,
  };
  next.registerPath = await normalizeRegisterPath(next.registerPath);
  await setOption(OPTION_KEY, next);
  return next;
}

export async function getPublicRegisterConfig() {
  const [member, notify] = await Promise.all([getMemberSettings(), getNotifySettings()]);

  const emailVerify = notify.register.emailVerify && notify.email.enabled;
  const phoneVerify = notify.register.phoneVerify && notify.sms.enabled;
  if (!member.registerEnabled) {
    return {
      enabled: false,
      path: null,
      nameRequired: true,
      passwordRequired: true,
      emailRequired: true,
      phoneRequired: false,
      emailVerify: false,
      phoneVerify: false,
      defaultRole: "subscriber" as const,
      inviteOnly: false,
      captcha: { enabled: false, mode: null as null | "builtin" | "custom" },
    };
  }
  return {
    enabled: true,
    path: member.registerPath,
    nameRequired: member.nameRequired,
    passwordRequired: member.passwordRequired,
    emailRequired: member.emailRequired,
    phoneRequired: member.phoneRequired,
    emailVerify,
    phoneVerify,
    defaultRole: member.defaultRole,
    inviteOnly: member.inviteOnly,
    captcha: {
      enabled: member.captchaEnabled,
      mode: member.captchaEnabled ? ("builtin" as const) : null,
    },
  };
}

const NAME_RE = /^[^\s@]{2,32}$/u;

const PHONE_LOCAL_RE = /^1[3-9]\d{9}$/;
const PHONE_INTL_RE = /^\+\d{6,15}$/;

function normalizePhone(raw: string): string {
  return raw.replace(/[\s-]/g, "");
}

async function generateUniqueName(): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const candidate = `用户${crypto.randomBytes(4).toString("hex")}`;
    const [taken] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.name}) = lower(${candidate})`);
    if (!taken) return candidate;
  }
  return `用户${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`.slice(0, 32);
}

export type RegisterInput = {
  name?: string;
  email?: string;
  phone?: string;
  password?: string;
  emailCode?: string;
  phoneCode?: string;
  inviteCode?: string;
};

export async function registerMember(input: RegisterInput): Promise<SessionUser> {
  await ensureMigrations();
  const member = await getMemberSettings();
  if (!member.registerEnabled) throw new ServiceError("注册已关闭", 404);

  if (member.captchaEnabled) {
    throw new ServiceError("注册验证码暂不可用，请稍后再试或联系站长", 503);
  }

  if (member.inviteOnly) {
    const code = (input.inviteCode ?? "").trim();
    if (!code) throw new ServiceError("请填写邀请码", 422);
    const hit = member.inviteCodes.some((c) => c.toLowerCase() === code.toLowerCase());
    if (!hit) throw new ServiceError("邀请码无效", 422);
  }

  let name = input.name?.trim() ?? "";
  if (name) {
    if (!NAME_RE.test(name)) {
      throw new ServiceError("昵称需为 2~32 个字符，且不能包含空格或 @", 422);
    }
  } else if (member.nameRequired) {
    throw new ServiceError("请填写昵称", 422);
  } else {
    name = await generateUniqueName();
  }

  const passwordRaw = input.password ?? "";
  let passwordHash: string;
  if (passwordRaw) {
    if (passwordRaw.length < 8 || passwordRaw.length > 200) {
      throw new ServiceError("密码长度需为 8~200 个字符", 422);
    }
    passwordHash = await hashPassword(passwordRaw);
  } else if (member.passwordRequired) {
    throw new ServiceError("请填写密码", 422);
  } else {
    passwordHash = await hashPassword(crypto.randomBytes(24).toString("hex"));
  }

  const emailRaw = input.email?.trim() || "";
  if (!emailRaw) {
    if (member.emailRequired) throw new ServiceError("请填写邮箱", 422);
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw) || emailRaw.length > 120) {
    throw new ServiceError("邮箱格式不正确", 422);
  }

  const phoneRaw = normalizePhone(input.phone ?? "");
  if (!phoneRaw) {
    if (member.phoneRequired) throw new ServiceError("请填写手机号", 422);
  } else if (!PHONE_LOCAL_RE.test(phoneRaw) && !PHONE_INTL_RE.test(phoneRaw)) {
    throw new ServiceError("手机号格式不正确", 422);
  }

  const notify = await getNotifySettings();
  if (notify.register.emailVerify && emailRaw) {
    await verifyCode({
      channel: "email",
      target: emailRaw,
      purpose: "register",
      code: input.emailCode ?? "",
    });
  }
  if (notify.register.phoneVerify && phoneRaw) {
    await verifyCode({
      channel: "sms",
      target: phoneRaw,
      purpose: "register",
      code: input.phoneCode ?? "",
    });
  }
  const emailVerifiedFlag = !!(emailRaw && notify.register.emailVerify);
  const phoneVerifiedFlag = !!(phoneRaw && notify.register.phoneVerify);

  if (input.name?.trim()) {
    const [nameTaken] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.name}) = lower(${name})`);
    if (nameTaken) throw new ServiceError("昵称已被占用", 422);
  }
  if (emailRaw) {
    const [emailTaken] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = lower(${emailRaw})`);
    if (emailTaken) throw new ServiceError("邮箱已被注册", 422);
  }
  if (phoneRaw) {
    const [phoneTaken] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`${users.phone} = ${phoneRaw}`);
    if (phoneTaken) throw new ServiceError("手机号已被注册", 422);
  }

  const [row] = await db
    .insert(users)
    .values({
      name,
      email: emailRaw || null,
      phone: phoneRaw || null,
      passwordHash,
      role: member.defaultRole,
      emailVerified: emailVerifiedFlag,
      phoneVerified: phoneVerifiedFlag,
    })
    .returning();

  if (!passwordRaw) await addPasswordlessMark(row.id);

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
  };
}

export { normalizeContactTarget };
