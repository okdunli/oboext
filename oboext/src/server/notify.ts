import { createHash, createHmac, randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db, ensureMigrations } from "./db.js";
import { verifyCodes } from "./schema.js";
import { getOption, setOption } from "./options.js";
import { getSettings } from "./queries.js";
import {
  issueCode,
  invalidateLatestCode,
  type CodeChannel,
  type CodePurpose,
} from "./verify-codes.js";
import { sendSmtpMail, type SmtpSecurity } from "./smtp.js";
import { ServiceError } from "./admin.js";
import { DEFAULT_LOCALE, makeT, type Locale } from "./i18n.js";

const OPTION_KEY = "notifySettings";

export interface WebhookCfg {
  url: string;
  method: "POST" | "GET" | "PUT";

  headers: string;

  body: string;
}

export type SmsProvider = "webhook" | "aliyun" | "tencent";

export interface AliyunSmsCfg {
  accessKeyId: string;

  accessKeySecret: string;

  signName: string;

  templateCode: string;

  codeParam: string;

  endpoint: string;
}

export interface TencentSmsCfg {
  secretId: string;

  secretKey: string;

  sdkAppId: string;
  signName: string;

  templateId: string;

  region: string;

  endpoint: string;
}

export interface NotifySettings {
  smtp: {
    host: string;
    port: number;
    security: SmtpSecurity;
    user: string;
    pass: string;
    from: string;
  };
  email: {
    enabled: boolean;
    via: "smtp" | "webhook";
    webhook: WebhookCfg;
  };
  sms: {
    enabled: boolean;

    provider: SmsProvider;

    signature: string;
    webhook: WebhookCfg;
    aliyun: AliyunSmsCfg;
    tencent: TencentSmsCfg;
  };
  register: {
    emailVerify: boolean;
    phoneVerify: boolean;
  };

  login: {
    emailVerify: boolean;
    phoneVerify: boolean;
  };
}

const DEFAULT_WEBHOOK: WebhookCfg = {
  url: "",
  method: "POST",
  headers: "Content-Type: application/json",
  body: '{"target":"{{target}}","code":"{{code}}"}',
};

const DEFAULT_ALIYUN: AliyunSmsCfg = {
  accessKeyId: "",
  accessKeySecret: "",
  signName: "",
  templateCode: "",
  codeParam: "code",
  endpoint: "",
};

const DEFAULT_TENCENT: TencentSmsCfg = {
  secretId: "",
  secretKey: "",
  sdkAppId: "",
  signName: "",
  templateId: "",
  region: "ap-guangzhou",
  endpoint: "",
};

const DEFAULT_SETTINGS: NotifySettings = {
  smtp: { host: "", port: 465, security: "TLS", user: "", pass: "", from: "" },
  email: { enabled: false, via: "smtp", webhook: { ...DEFAULT_WEBHOOK } },
  sms: {
    enabled: false,
    provider: "webhook",
    signature: "oboext",
    webhook: { ...DEFAULT_WEBHOOK },
    aliyun: { ...DEFAULT_ALIYUN },
    tencent: { ...DEFAULT_TENCENT },
  },
  register: { emailVerify: false, phoneVerify: false },
  login: { emailVerify: false, phoneVerify: false },
};

function mergeWebhook(cur: WebhookCfg, raw: Partial<WebhookCfg> | undefined): WebhookCfg {
  if (!raw) return cur;
  return {
    url: typeof raw.url === "string" ? raw.url : cur.url,
    method:
      raw.method === "POST" || raw.method === "GET" || raw.method === "PUT"
        ? raw.method
        : cur.method,
    headers: typeof raw.headers === "string" ? raw.headers : cur.headers,
    body: typeof raw.body === "string" ? raw.body : cur.body,
  };
}

export async function getNotifySettings(): Promise<NotifySettings> {
  const stored = (await getOption<Partial<NotifySettings>>(OPTION_KEY, {})) ?? {};
  return {
    smtp: { ...DEFAULT_SETTINGS.smtp, ...(stored.smtp ?? {}) },
    email: {
      ...DEFAULT_SETTINGS.email,
      ...(stored.email ?? {}),
      webhook: mergeWebhook({ ...DEFAULT_WEBHOOK }, stored.email?.webhook),
    },
    sms: {
      ...DEFAULT_SETTINGS.sms,
      ...(stored.sms ?? {}),
      webhook: mergeWebhook({ ...DEFAULT_WEBHOOK }, stored.sms?.webhook),
      aliyun: { ...DEFAULT_ALIYUN, ...(stored.sms?.aliyun ?? {}) },
      tencent: { ...DEFAULT_TENCENT, ...(stored.sms?.tencent ?? {}) },
    },
    register: { ...DEFAULT_SETTINGS.register, ...(stored.register ?? {}) },
    login: { ...DEFAULT_SETTINGS.login, ...(stored.login ?? {}) },
  };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export async function saveNotifySettings(input: DeepPartial<NotifySettings>): Promise<NotifySettings> {
  const cur = await getNotifySettings();
  const next: NotifySettings = {
    smtp: {
      host: String(input.smtp?.host ?? cur.smtp.host).trim(),
      port: Number(input.smtp?.port ?? cur.smtp.port) || 465,
      security:
        input.smtp?.security === "TLS" ||
        input.smtp?.security === "STARTTLS" ||
        input.smtp?.security === "NONE"
          ? input.smtp.security
          : cur.smtp.security,
      user: String(input.smtp?.user ?? cur.smtp.user).trim(),

      pass: input.smtp && "pass" in input.smtp ? String(input.smtp.pass ?? "") : cur.smtp.pass,
      from: String(input.smtp?.from ?? cur.smtp.from).trim(),
    },
    email: {
      enabled:
        typeof input.email?.enabled === "boolean" ? input.email.enabled : cur.email.enabled,
      via:
        input.email?.via === "webhook" || input.email?.via === "smtp"
          ? input.email.via
          : cur.email.via,
      webhook: mergeWebhook(cur.email.webhook, input.email?.webhook),
    },
    sms: (() => {
      const raw = input.sms ?? {};
      const provider: SmsProvider =
        raw.provider === "aliyun" || raw.provider === "tencent" || raw.provider === "webhook"
          ? raw.provider
          : cur.sms.provider;

      const keepSecret = (oldVal: string, v: unknown) =>
        typeof v === "undefined" ? oldVal : String(v);
      const text = (oldVal: string, v: unknown, max = 200) =>
        typeof v === "string" ? v.trim().slice(0, max) : oldVal;
      const nextSms: NotifySettings["sms"] = {
        enabled: typeof raw.enabled === "boolean" ? raw.enabled : cur.sms.enabled,
        provider,
        signature: text(cur.sms.signature, raw.signature, 40),
        webhook: mergeWebhook(cur.sms.webhook, raw.webhook),
        aliyun: {
          accessKeyId: text(cur.sms.aliyun.accessKeyId, raw.aliyun?.accessKeyId),
          accessKeySecret: keepSecret(cur.sms.aliyun.accessKeySecret, raw.aliyun?.accessKeySecret),
          signName: text(cur.sms.aliyun.signName, raw.aliyun?.signName, 100),
          templateCode: text(cur.sms.aliyun.templateCode, raw.aliyun?.templateCode, 100),
          codeParam: text(cur.sms.aliyun.codeParam || "code", raw.aliyun?.codeParam, 40) || "code",
          endpoint: text(cur.sms.aliyun.endpoint, raw.aliyun?.endpoint, 300),
        },
        tencent: {
          secretId: text(cur.sms.tencent.secretId, raw.tencent?.secretId),
          secretKey: keepSecret(cur.sms.tencent.secretKey, raw.tencent?.secretKey),
          sdkAppId: text(cur.sms.tencent.sdkAppId, raw.tencent?.sdkAppId, 64),
          signName: text(cur.sms.tencent.signName, raw.tencent?.signName, 100),
          templateId: text(cur.sms.tencent.templateId, raw.tencent?.templateId, 64),
          region: text(cur.sms.tencent.region || "ap-guangzhou", raw.tencent?.region, 64) || "ap-guangzhou",
          endpoint: text(cur.sms.tencent.endpoint, raw.tencent?.endpoint, 300),
        },
      };

      if (nextSms.enabled) {
        const endpointOk = (u: string) => {
          if (!u) return;
          let parsed: URL;
          try {
            parsed = new URL(u);
          } catch {
            throw new ServiceError("短信接入点地址不是合法 URL");
          }
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new ServiceError("短信接入点地址仅支持 http/https");
          }
        };
        if (provider === "aliyun") {
          const a = nextSms.aliyun;
          if (!a.accessKeyId || !a.accessKeySecret || !a.signName || !a.templateCode) {
            throw new ServiceError("阿里云短信缺少 AccessKey、签名或模板等必填配置");
          }
          endpointOk(a.endpoint);
        } else if (provider === "tencent") {
          const t = nextSms.tencent;
          if (!t.secretId || !t.secretKey || !t.sdkAppId || !t.signName || !t.templateId) {
            throw new ServiceError("腾讯云短信缺少 SecretId、SdkAppId、签名或模板等必填配置");
          }
          endpointOk(t.endpoint);
        }
      }
      return nextSms;
    })(),
    register: {
      emailVerify:
        typeof input.register?.emailVerify === "boolean"
          ? input.register.emailVerify
          : cur.register.emailVerify,
      phoneVerify:
        typeof input.register?.phoneVerify === "boolean"
          ? input.register.phoneVerify
          : cur.register.phoneVerify,
    },
    login: {
      emailVerify:
        typeof input.login?.emailVerify === "boolean"
          ? input.login.emailVerify
          : cur.login.emailVerify,
      phoneVerify:
        typeof input.login?.phoneVerify === "boolean"
          ? input.login.phoneVerify
          : cur.login.phoneVerify,
    },
  };
  await setOption(OPTION_KEY, next);
  return next;
}

export function renderTpl(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? "");
}

export function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const text = raw.trim();
  if (!text) return out;
  if (text.startsWith("{")) {
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      for (const [k, v] of Object.entries(j)) out[k] = String(v);
      return out;
    } catch {
      throw new ServiceError("请求头 JSON 格式不正确", 422);
    }
  }
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

async function invokeWebhook(cfg: WebhookCfg, vars: Record<string, string>): Promise<void> {
  if (!cfg.url || !/^https?:\/\//i.test(cfg.url)) {
    throw new ServiceError("Webhook 地址未正确配置（需 http/https 开头）");
  }
  const url = renderTpl(cfg.url, vars);
  const method = cfg.method;
  const headers = parseHeaders(cfg.headers);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: method === "GET" ? undefined : renderTpl(cfg.body, vars),
      signal: ctrl.signal,
      cache: "no-store",
    });

    if (!res.ok) throw new Error(`webhook ${res.status}`);
  } catch (e) {
    if (e instanceof ServiceError) throw e;
    throw new ServiceError("验证码通道暂不可用，请稍后再试");
  } finally {
    clearTimeout(timer);
  }
}

const ALIYUN_SMS_ENDPOINT = "https://dysmsapi.aliyuncs.com";
const TENCENT_SMS_VERSION = "2021-01-11";

function timeoutFetch(url: string, init: RequestInit, ms = 8000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...init, signal: ctrl.signal, cache: "no-store" }).finally(() =>
    clearTimeout(timer),
  );
}

function pctEncode(s: string): string {
  return encodeURIComponent(s)
    .replace(/\+/g, "%20")
    .replace(/\*/g, "%2A")
    .replace(/%7E/g, "~");
}

function normalizePhone(raw: string): string {
  const s = raw.replace(/[\s-]/g, "");
  if (s.startsWith("+")) return s;
  if (/^1\d{10}$/.test(s)) return `+86${s}`;
  return /^\d+$/.test(s) ? `+${s}` : s;
}

async function sendViaAliyunSms(cfg: AliyunSmsCfg, phone: string, code: string): Promise<void> {
  const params: Record<string, string> = {
    Action: "SendSms",
    Version: "2017-05-25",
    Format: "JSON",
    RegionId: "cn-hangzhou",
    AccessKeyId: cfg.accessKeyId,
    SignatureMethod: "HMAC-SHA1",
    SignatureVersion: "1.0",
    SignatureNonce: randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    PhoneNumbers: phone,
    SignName: cfg.signName,
    TemplateCode: cfg.templateCode,
    TemplateParam: JSON.stringify({ [cfg.codeParam || "code"]: code }),
  };
  const canonical = Object.keys(params)
    .sort()
    .map((k) => `${pctEncode(k)}=${pctEncode(params[k])}`)
    .join("&");
  const stringToSign = `GET&${pctEncode("/")}&${pctEncode(canonical)}`;
  const signature = createHmac("sha1", `${cfg.accessKeySecret}&`)
    .update(stringToSign)
    .digest("base64");
  const base = (cfg.endpoint || ALIYUN_SMS_ENDPOINT).replace(/\/+$/, "");
  const url = `${base}/?${canonical}&Signature=${pctEncode(signature)}`;
  let res: Response;
  try {
    res = await timeoutFetch(url, { method: "GET" });
  } catch {
    throw new ServiceError("短信服务暂不可用，请稍后再试");
  }
  let j: { Code?: string; Message?: string } | null = null;
  try {
    j = (await res.json()) as { Code?: string; Message?: string };
  } catch {
    throw new ServiceError("短信服务响应解析失败");
  }

  if (!res.ok || j.Code !== "OK") {
    throw new ServiceError(`短信发送失败${j.Code ? `（${j.Code}）` : ""}`);
  }
}

async function sendViaTencentSms(cfg: TencentSmsCfg, phone: string, code: string): Promise<void> {
  const origin = (
    cfg.endpoint || `https://sms.${cfg.region || "ap-guangzhou"}.tencentcloudapi.com`
  ).replace(/\/+$/, "");
  const host = new URL(origin).host;
  const payload = JSON.stringify({
    PhoneNumberSet: [normalizePhone(phone)],
    SmsSdkAppId: cfg.sdkAppId,
    SignName: cfg.signName,
    TemplateId: cfg.templateId,

    TemplateParamSet: [code],
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sha256Hex = (data: string): string => createHash("sha256").update(data).digest("hex");
  const hmac = (key: Buffer | string, data: string): Buffer =>
    createHmac("sha256", key).update(data).digest();

  const canonical = [
    "POST",
    "/",
    "",
    "content-type:application/json; charset=utf-8",
    `host:${host}`,
    "x-tc-action:sendsms",
    "",
    "content-type;host;x-tc-action",
    sha256Hex(payload),
  ].join("\n");
  const date = new Date().toISOString().slice(0, 10);
  const scope = `${date}/sms/tc3_request`;
  const stringToSign = ["TC3-HMAC-SHA256", timestamp, scope, sha256Hex(canonical)].join("\n");
  const secretSigning = hmac(hmac(hmac(`TC3${cfg.secretKey}`, date), "sms"), "tc3_request");
  const signature = createHmac("sha256", secretSigning).update(stringToSign).digest("hex");
  const authorization =
    `TC3-HMAC-SHA256 Credential=${cfg.secretId}/${scope}, ` +
    "SignedHeaders=content-type;host;x-tc-action, " +
    `Signature=${signature}`;

  let res: Response;
  try {
    res = await timeoutFetch(`${origin}/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: authorization,
        "X-TC-Action": "SendSms",
        "X-TC-Version": TENCENT_SMS_VERSION,
        "X-TC-Timestamp": timestamp,
      },
      body: payload,
    });
  } catch {
    throw new ServiceError("短信服务暂不可用，请稍后再试");
  }
  type TencentSmsResult = {
    Response?: {
      Error?: { Code?: string };
      SendStatusSet?: { Code?: string; Message?: string }[];
    };
  };
  let j: TencentSmsResult | null = null;
  try {
    j = (await res.json()) as TencentSmsResult;
  } catch {
    throw new ServiceError("短信服务响应解析失败");
  }
  const st = j?.Response?.SendStatusSet?.[0];
  if (!res.ok || !st || st.Code !== "Ok") {
    const code0 = st?.Code || j?.Response?.Error?.Code || "";
    throw new ServiceError(`短信发送失败${code0 ? `（${code0}）` : ""}`);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

async function deliverViaEmail(
  to: string,
  subject: string,
  text: string,
  html: string,
  vars: { code?: string; purpose?: string } = {},
) {
  const s = await getNotifySettings();
  if (!s.email.enabled) throw new ServiceError("邮件通道未开启");
  if (s.email.via === "webhook") {

    await invokeWebhook(s.email.webhook, {
      target: to,
      code: vars.code ?? "",
      sign: s.sms.signature,
      purpose: vars.purpose ?? "",
    });
    return;
  }
  if (!s.smtp.host) throw new ServiceError("SMTP 未配置");
  await sendSmtpMail(
    {
      host: s.smtp.host,
      port: s.smtp.port,
      security: s.smtp.security,
      user: s.smtp.user,
      pass: s.smtp.pass,
      from: s.smtp.from || s.smtp.user,
    },
    { to, subject, text, html },
  );
}

async function deliverViaSms(to: string, code: string) {
  const s = await getNotifySettings();
  if (!s.sms.enabled) throw new ServiceError("短信通道未开启");
  if (s.sms.provider === "aliyun") {
    await sendViaAliyunSms(s.sms.aliyun, to, code);
    return;
  }
  if (s.sms.provider === "tencent") {
    await sendViaTencentSms(s.sms.tencent, to, code);
    return;
  }
  await invokeWebhook(s.sms.webhook, {
    target: to,
    code,
    sign: s.sms.signature,
    purpose: "",
  });
}

const PURPOSE_LABEL_KEY: Record<CodePurpose, string> = {
  register: "notify.label_register",
  reset: "notify.label_reset",
  bind: "notify.label_bind",
  login: "notify.label_login",
};

/**
 * The verification-code email in the recipient's locale. The templates live
 * in the catalog (notify.subject / notify.body / notify.html_lead /
 * notify.html_foot), so a new language is a catalog edit, not a code edit;
 * the zh output stays byte-equal to the pre-i18n template. siteName is
 * escaped only inside the HTML body, matching the original markup.
 */
export function renderVerificationEmail(
  locale: Locale,
  siteName: string,
  purpose: CodePurpose,
  code: string,
): { subject: string; text: string; html: string } {
  const t = makeT(locale);
  const label = t(PURPOSE_LABEL_KEY[purpose]);
  const html =
    `<div style="padding:24px;font-family:system-ui,sans-serif">` +
    `<h2 style="margin:0 0 12px">${escapeHtml(siteName)}</h2>` +
    `<p>${t("notify.html_lead", { label })}</p>` +
    `<p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p>` +
    `<p style="color:#888;font-size:12px">${t("notify.html_foot")}</p>` +
    `</div>`;
  return {
    subject: t("notify.subject", { site: siteName, label, code }),
    text: t("notify.body", { label, code }),
    html,
  };
}

export async function sendVerificationCode(input: {
  channel: CodeChannel;
  target: string;
  purpose: CodePurpose;
  ip?: string | null;
  locale?: Locale;
}): Promise<{ resendAfter: number }> {
  await ensureMigrations();
  const code = await issueCode(input);
  try {
    const settings = await getSettings();
    const siteName = settings.siteTitle || "oboext";
    if (input.channel === "email") {
      const { subject, text, html } = renderVerificationEmail(
        input.locale ?? DEFAULT_LOCALE,
        siteName,
        input.purpose,
        code,
      );
      await deliverViaEmail(input.target, subject, text, html, {
        code,
        purpose: input.purpose,
      });
    } else {
      await deliverViaSms(input.target, code);
    }
    return { resendAfter: 60 };
  } catch (e) {
    await invalidateLatestCode(input);
    throw e;
  }
}

export async function sendTestMessage(channel: CodeChannel, target: string): Promise<void> {
  if (channel === "email") {
    await deliverViaEmail(
      target,
      "oboext 通知通道测试",
      "这是一封来自 oboext 的测试邮件，收到即表示 SMTP / Webhook 配置可用。",
      "<p>这是一封来自 <b>oboext</b> 的测试邮件，收到即表示通知通道配置可用。</p>",

      { code: "888888", purpose: "test" },
    );
  } else {

    await deliverViaSms(target, "888888");
  }
}

export async function peekLatestLiveCode(
  channel: CodeChannel,
  target: string,
  purpose: CodePurpose,
): Promise<{ createdAt: Date; expiresAt: Date } | null> {
  const [row] = await db
    .select({ createdAt: verifyCodes.createdAt, expiresAt: verifyCodes.expiresAt })
    .from(verifyCodes)
    .where(
      and(
        eq(verifyCodes.target, target),
        eq(verifyCodes.channel, channel),
        eq(verifyCodes.purpose, purpose),
        isNull(verifyCodes.consumedAt),
      ),
    )
    .orderBy(desc(verifyCodes.id))
    .limit(1);
  return row ?? null;
}
