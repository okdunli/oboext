

import crypto from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { and, eq, sql } from "drizzle-orm";
import { db, ensureMigrations } from "./db.js";
import { users, oauthIdentities } from "./schema.js";
import { getSecret, hashPassword } from "./auth.js";
import type { SessionUser } from "./auth.js";
import { getOption, setOption } from "./options.js";
import { addPasswordlessMark, getPasswordlessSet } from "./passwordless.js";
import { getMemberSettings } from "./members.js";
import { ServiceError } from "./errors.js";

const SETTINGS_KEY = "oauth.settings";
export const STATE_COOKIE = "oauth_state";

export type PresetKind =
  | "qq"
  | "wechat"
  | "weibo"
  | "dingtalk"
  | "douyin"
  | "github"
  | "linuxdo";

export interface ProviderConfig {
  enabled: boolean;
  clientId: string;
  clientSecret: string;

  allowCreate: boolean;

  mergeByEmail: boolean;

  label?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  userInfoUrl?: string;
  tokenMethod?: "POST" | "GET";

  tokenAuth?: "body" | "basic";

  userInfoAuth?: "bearer" | "query";
  scope?: string;
  openIdField?: string;
  nicknameField?: string;
  avatarField?: string;
  emailField?: string;
  emailVerifiedField?: string;
}

interface OAuthSettings {
  providers: Record<string, ProviderConfig>;
}

export interface PublicProvider {
  key: string;
  label: string;
  color: string;
}

export interface AdminProvider extends PublicProvider {
  custom: boolean;
  config: ProviderConfig;

  hasSecret: boolean;
  complete: boolean;
}

interface NormalizedProfile {
  openId: string;
  nickname: string;
  avatarUrl: string | null;
  email: string | null;
  emailVerified: boolean;
  raw: Record<string, unknown>;
}

interface ExchangeContext {
  config: ProviderConfig;
  code: string;
  redirectUri: string;
  http: HttpFn;
}

type HttpFn = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{ status: number; body: string; json: () => unknown }>;

interface Preset {
  kind: PresetKind;
  label: string;
  color: string;
  scope: string;
  buildAuthorizeUrl: (p: {
    clientId: string;
    redirectUri: string;
    state: string;
    scope: string;
  }) => string;
  exchange: (ctx: ExchangeContext) => Promise<NormalizedProfile>;
}

function buildAuthorize(
  base: string,
  params: Record<string, string>,
  suffix = "",
): string {
  const qs = new URLSearchParams(params).toString();
  return `${base}${base.includes("?") ? "&" : "?"}${qs}${suffix}`;
}

function makeHttp(): HttpFn {
  return async (url, init = {}) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method ?? "GET",
        headers: init.headers,
        body: init.body,
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new ServiceError(
        `请求第三方接口失败：${e instanceof Error ? e.message : "网络错误"}`,
        502,
      );
    } finally {
      clearTimeout(timer);
    }
    const body = await res.text();
    return {
      status: res.status,
      body,
      json() {
        const text = body.trim();

        const clean = text.match(/^[\w.]*\((.*)\);?$/s)
          ? text.replace(/^[\w.]*\(/, "").replace(/\);?$/, "")
          : text;
        try {
          return JSON.parse(clean);
        } catch {

          return Object.fromEntries(new URLSearchParams(clean));
        }
      },
    };
  };
}

function asRecord(v: unknown): Record<string, any> {
  return v && typeof v === "object" ? (v as Record<string, any>) : {};
}

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

const PRESETS: Record<PresetKind, Preset> = {
  qq: {
    kind: "qq",
    label: "QQ",
    color: "#12B7F5",
    scope: "get_user_info",
    buildAuthorizeUrl: ({ clientId, redirectUri, state }) =>
      buildAuthorize("https://graph.qq.com/oauth2.0/authorize", {
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        state,
      }),
    async exchange({ config, code, redirectUri, http }) {
      const tokenUrl = buildAuthorize("https://graph.qq.com/oauth2.0/token", {
        grant_type: "authorization_code",
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: redirectUri,
        fmt: "json",
      });
      const tok = asRecord((await http(tokenUrl)).json());
      const accessToken = str(tok.access_token);
      if (!accessToken) throw new ServiceError("QQ 令牌交换失败", 502);

      const meUrl = buildAuthorize("https://graph.qq.com/oauth2.0/me", {
        access_token: accessToken,
        fmt: "json",
        oauth_consumer_key: config.clientId,
      });
      const me = asRecord((await http(meUrl)).json());
      const openId = str(me.openid);
      if (!openId) throw new ServiceError("QQ 未能获取 openid", 502);

      const infoUrl = buildAuthorize(
        "https://graph.qq.com/oauth2.0/user/get_user_info",
        {
          access_token: accessToken,
          oauth_consumer_key: config.clientId,
          openid: openId,
        },
      );
      const info = asRecord((await http(infoUrl)).json());
      return {
        openId,
        nickname: str(info.nickname) || "QQ用户",
        avatarUrl: str(info.figureurl_qq_1 || info.figureurl_2) || null,
        email: null,
        emailVerified: false,
        raw: info,
      };
    },
  },

  wechat: {
    kind: "wechat",
    label: "微信",
    color: "#07C160",
    scope: "snsapi_login",
    buildAuthorizeUrl: ({ clientId, redirectUri, state }) =>
      buildAuthorize("https://open.weixin.qq.com/connect/qrconnect", {
        appid: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "snsapi_login",
        state,
      }, "#wechat_redirect"),
    async exchange({ config, code, http }) {
      const url = buildAuthorize(
        "https://api.weixin.qq.com/sns/oauth2/access_token",
        {
          appid: config.clientId,
          secret: config.clientSecret,
          code,
          grant_type: "authorization_code",
        },
      );
      const tok = asRecord((await http(url)).json());
      const accessToken = str(tok.access_token);
      const openId = str(tok.openid);
      if (!accessToken || !openId) {
        throw new ServiceError(
          `微信令牌交换失败：${str(tok.errmsg) || "未知错误"}`,
          502,
        );
      }
      const infoUrl = buildAuthorize("https://api.weixin.qq.com/sns/userinfo", {
        access_token: accessToken,
        openid: openId,
      });
      const info = asRecord((await http(infoUrl)).json());
      return {
        openId,
        nickname: str(info.nickname) || "微信用户",
        avatarUrl: str(info.headimgurl) || null,
        email: null,
        emailVerified: false,
        raw: info,
      };
    },
  },

  weibo: {
    kind: "weibo",
    label: "微博",
    color: "#E6162D",
    scope: "",
    buildAuthorizeUrl: ({ clientId, redirectUri, state, scope }) =>
      buildAuthorize("https://api.weibo.com/oauth2/authorize", {
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        state,
        ...(scope ? { scope } : {}),
      }),
    async exchange({ config, code, redirectUri, http }) {
      const tokRes = await http("https://api.weibo.com/oauth2/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
        }).toString(),
      });
      const tok = asRecord(tokRes.json());
      const accessToken = str(tok.access_token);
      if (!accessToken) throw new ServiceError("微博令牌交换失败", 502);

      let uid = str(tok.uid);
      if (!uid) {
        const uidRes = await http(
          buildAuthorize("https://api.weibo.com/2/account/get_uid.json", {
            access_token: accessToken,
          }),
        );
        uid = str(asRecord(uidRes.json()).uid);
      }
      if (!uid) throw new ServiceError("微博未能获取 uid", 502);

      const infoRes = await http(
        buildAuthorize("https://api.weibo.com/2/users/show.json", {
          access_token: accessToken,
          uid,
        }),
      );
      const info = asRecord(infoRes.json());
      return {
        openId: uid,
        nickname: str(info.screen_name) || "微博用户",
        avatarUrl: str(info.profile_image_url) || null,
        email: null,
        emailVerified: false,
        raw: info,
      };
    },
  },

  dingtalk: {
    kind: "dingtalk",
    label: "钉钉",
    color: "#1677FF",
    scope: "openid",
    buildAuthorizeUrl: ({ clientId, redirectUri, state }) =>
      buildAuthorize("https://login.dingtalk.com/oauth2/auth", {
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: "openid",
        state,
        prompt: "consent",
      }),
    async exchange({ config, code, http }) {
      const tokRes = await http(
        "https://api.dingtalk.com/v1.0/oauth2/userAccessToken",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            code,
            grantType: "authorization_code",
          }),
        },
      );
      const tok = asRecord(tokRes.json());
      const accessToken = str(tok.accessToken);
      if (!accessToken) throw new ServiceError("钉钉令牌交换失败", 502);
      const me = asRecord(
        (
          await http("https://api.dingtalk.com/v1.0/contact/users/me", {
            method: "GET",
            headers: { "x-acs-dingtalk-access-token": accessToken },
          })
        ).json(),
      );
      const openId = str(me.openId || me.unionId);
      if (!openId) throw new ServiceError("钉钉未能获取用户信息", 502);
      return {
        openId,
        nickname: str(me.nick) || "钉钉用户",
        avatarUrl: str(me.avatarUrl) || null,
        email: str(me.email) || null,

        emailVerified: !!str(me.email),
        raw: me,
      };
    },
  },

  douyin: {
    kind: "douyin",
    label: "抖音",
    color: "#FE2C55",
    scope: "user_info",
    buildAuthorizeUrl: ({ clientId, redirectUri, state, scope }) =>
      buildAuthorize("https://open.douyin.com/platform/oauth/connect/", {
        client_key: clientId,
        response_type: "code",
        scope: scope || "user_info",
        redirect_uri: redirectUri,
        state,
      }),
    async exchange({ config, code, http }) {
      const url = buildAuthorize("https://open.douyin.com/oauth/access_token/", {
        client_key: config.clientId,
        client_secret: config.clientSecret,
        code,
        grant_type: "authorization_code",
      });
      const tok = asRecord(asRecord((await http(url)).json()).data);
      const accessToken = str(tok.access_token);
      const openId = str(tok.open_id);
      if (!accessToken || !openId) {
        throw new ServiceError("抖音令牌交换失败", 502);
      }
      const infoUrl = buildAuthorize("https://open.douyin.com/oauth/userinfo/", {
        access_token: accessToken,
        open_id: openId,
      });
      const info = asRecord(asRecord((await http(infoUrl)).json()).data);
      return {
        openId: str(info.open_id) || openId,
        nickname: str(info.nickname) || "抖音用户",
        avatarUrl: str(info.avatar) || null,
        email: null,
        emailVerified: false,
        raw: info,
      };
    },
  },

  github: {
    kind: "github",
    label: "GitHub",
    color: "#24292F",
    scope: "user:email",
    buildAuthorizeUrl: ({ clientId, redirectUri, state, scope }) =>
      buildAuthorize("https://github.com/login/oauth/authorize", {
        client_id: clientId,
        redirect_uri: redirectUri,
        ...(scope ? { scope } : {}),
        state,
      }),
    async exchange({ config, code, redirectUri, http }) {
      const tokRes = await http("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      });
      const tok = asRecord(tokRes.json());
      const accessToken = str(tok.access_token);
      if (!accessToken) {
        throw new ServiceError(
          `GitHub 令牌交换失败：${str(tok.error_description) || str(tok.error)}`,
          502,
        );
      }
      const auth = {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
      };
      const me = asRecord(
        (await http("https://api.github.com/user", { headers: auth })).json(),
      );
      const openId = str(me.id);
      if (!openId) throw new ServiceError("GitHub 未能获取用户信息", 502);

      let email = str(me.email);
      let emailVerified = !!email;
      if (!email) {

        const list = (await http("https://api.github.com/user/emails", {
          headers: auth,
        }).then((r) => r.json())) as Array<Record<string, unknown>>;
        const primary = (Array.isArray(list) ? list : []).find(
          (x) => x.primary && x.verified,
        );
        if (primary) {
          email = str(primary.email);
          emailVerified = true;
        }
      }
      return {
        openId,
        nickname: str(me.name || me.login) || "GitHub用户",
        avatarUrl: str(me.avatar_url) || null,
        email: email || null,
        emailVerified,
        raw: me,
      };
    },
  },

  linuxdo: {
    kind: "linuxdo",
    label: "linux do",
    color: "#E86D48",
    scope: "",
    buildAuthorizeUrl: ({ clientId, redirectUri, state }) =>
      buildAuthorize("https://connect.linux.do/oauth2/authorize", {
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        state,
      }),
    async exchange({ config, code, redirectUri, http }) {
      const tokRes = await http("https://connect.linux.do/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        }).toString(),
      });
      const tok = asRecord(tokRes.json());
      const accessToken = str(tok.access_token);
      if (!accessToken) throw new ServiceError("linux do 令牌交换失败", 502);
      const me = asRecord(
        (
          await http("https://connect.linux.do/api/user", {
            headers: { Authorization: `Bearer ${accessToken}` },
          })
        ).json(),
      );
      const openId = str(me.id);
      if (!openId) throw new ServiceError("linux do 未能获取用户信息", 502);
      return {
        openId,
        nickname: str(me.name || me.username) || "LinuxDo用户",
        avatarUrl: str(me.avatar_url) || null,
        email: str(me.email) || null,

        emailVerified: !!str(me.email),
        raw: me,
      };
    },
  },
};

function defaultConfig(): ProviderConfig {
  return {
    enabled: false,
    clientId: "",
    clientSecret: "",
    allowCreate: true,
    mergeByEmail: true,
  };
}

export async function getOauthSettings(): Promise<OAuthSettings> {
  const stored = await getOption<Partial<OAuthSettings>>(SETTINGS_KEY, {});
  return { providers: stored?.providers ?? {} };
}

async function writeSettings(next: OAuthSettings): Promise<void> {
  await setOption(SETTINGS_KEY, next);
}

const CUSTOM_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const customKey = (slug: string) => `custom:${slug}`;
const isCustomKey = (key: string) => key.startsWith("custom:");

function isPresetKey(key: string): key is PresetKind {
  return key in PRESETS;
}

function customLabel(config: ProviderConfig, slug: string): string {
  return config.label?.trim() || slug;
}

async function resolveProvider(
  key: string,
): Promise<{ preset: Preset | null; config: ProviderConfig; label: string; color: string }> {
  const settings = await getOauthSettings();
  const stored = settings.providers[key] ?? defaultConfig();
  if (isPresetKey(key)) {
    const preset = PRESETS[key];
    return { preset, config: stored, label: preset.label, color: preset.color };
  }
  if (isCustomKey(key)) {
    const slug = key.slice("custom:".length);
    if (!CUSTOM_SLUG_RE.test(slug) || !settings.providers[key]) {
      throw new ServiceError("登录方式不存在", 404);
    }
    return {
      preset: null,
      config: stored,
      label: customLabel(stored, slug),
      color: "#6366F1",
    };
  }
  throw new ServiceError("登录方式不存在", 404);
}

export async function listAdminProviders(): Promise<AdminProvider[]> {
  const settings = await getOauthSettings();
  const out: AdminProvider[] = [];
  for (const kind of Object.keys(PRESETS) as PresetKind[]) {
    const preset = PRESETS[kind];
    const cfg = settings.providers[kind] ?? defaultConfig();
    out.push({
      key: kind,
      label: preset.label,
      color: preset.color,
      custom: false,
      config: { ...cfg, clientSecret: "" },
      hasSecret: !!cfg.clientSecret,
      complete: !!(cfg.clientId && cfg.clientSecret),
    });
  }
  for (const [key, cfg] of Object.entries(settings.providers)) {
    if (!isCustomKey(key)) continue;
    const slug = key.slice("custom:".length);
    out.push({
      key,
      label: customLabel(cfg, slug),
      color: "#6366F1",
      custom: true,
      config: { ...cfg, clientSecret: "" },
      hasSecret: !!cfg.clientSecret,
      complete: !!(
        cfg.clientId &&
        cfg.clientSecret &&
        cfg.authorizeUrl &&
        cfg.tokenUrl &&
        cfg.userInfoUrl &&
        cfg.openIdField
      ),
    });
  }
  return out;
}

export async function getPublicProviders(): Promise<PublicProvider[]> {
  const all = await listAdminProviders();
  return all
    .filter((p) => p.config.enabled && p.complete)
    .map(({ key, label, color }) => ({ key, label, color }));
}

function assertUrl(v: string, field: string): void {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new ServiceError(`${field} 不是合法网址`, 422);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new ServiceError(`${field} 仅支持 http/https`, 422);
  }
}

export async function savePresetProvider(
  kind: PresetKind,
  patch: Partial<ProviderConfig>,
): Promise<void> {
  if (!PRESETS[kind]) throw new ServiceError("登录方式不存在", 404);
  const settings = await getOauthSettings();
  const cur = settings.providers[kind] ?? defaultConfig();
  const next: ProviderConfig = {
    ...cur,
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : cur.enabled,
    clientId:
      typeof patch.clientId === "string" ? patch.clientId.trim() : cur.clientId,
    clientSecret:
      typeof patch.clientSecret === "string"
        ? patch.clientSecret || cur.clientSecret
        : cur.clientSecret,
    allowCreate:
      typeof patch.allowCreate === "boolean"
        ? patch.allowCreate
        : cur.allowCreate,
    mergeByEmail:
      typeof patch.mergeByEmail === "boolean"
        ? patch.mergeByEmail
        : cur.mergeByEmail,
  };
  if (next.enabled && (!next.clientId || !next.clientSecret)) {
    throw new ServiceError("启用前请填写 AppID 与 AppSecret", 422);
  }
  settings.providers[kind] = next;
  await writeSettings(settings);
}

export async function addCustomProvider(
  input: Omit<ProviderConfig, "enabled"> & { slug: string; enabled?: boolean },
): Promise<string> {
  const slug = input.slug?.trim().toLowerCase();
  if (!slug || !CUSTOM_SLUG_RE.test(slug)) {
    throw new ServiceError(
      "标识仅允许小写字母、数字、短横线，且以字母数字开头",
      422,
    );
  }
  const key = customKey(slug);
  const settings = await getOauthSettings();
  if (settings.providers[key]) throw new ServiceError("该标识已存在", 422);

  const label = input.label?.trim();
  if (!label || label.length > 32) {
    throw new ServiceError("请填写 1~32 字的显示名称", 422);
  }
  assertUrl(input.authorizeUrl ?? "", "授权地址");
  assertUrl(input.tokenUrl ?? "", "令牌地址");
  assertUrl(input.userInfoUrl ?? "", "用户信息地址");
  if (!input.openIdField?.trim()) {
    throw new ServiceError("请填写用户唯一 ID 字段", 422);
  }

  const cfg: ProviderConfig = {
    enabled: input.enabled ?? false,
    clientId: (input.clientId ?? "").trim(),
    clientSecret: input.clientSecret ?? "",
    allowCreate: input.allowCreate ?? true,
    mergeByEmail: input.mergeByEmail ?? true,
    label,
    authorizeUrl: input.authorizeUrl!.trim(),
    tokenUrl: input.tokenUrl!.trim(),
    userInfoUrl: input.userInfoUrl!.trim(),
    tokenMethod: input.tokenMethod === "GET" ? "GET" : "POST",
    tokenAuth: input.tokenAuth === "basic" ? "basic" : "body",
    userInfoAuth: input.userInfoAuth === "query" ? "query" : "bearer",
    scope: input.scope?.trim() || "",
    openIdField: input.openIdField.trim(),
    nicknameField: input.nicknameField?.trim() || "name",
    avatarField: input.avatarField?.trim() || "avatar",
    emailField: input.emailField?.trim() || "",
    emailVerifiedField: input.emailVerifiedField?.trim() || "",
  };
  if (cfg.enabled && (!cfg.clientId || !cfg.clientSecret)) {
    throw new ServiceError("启用前请填写客户端 ID 与密钥", 422);
  }
  settings.providers[key] = cfg;
  await writeSettings(settings);
  return key;
}

export async function saveCustomProvider(
  key: string,
  patch: Partial<ProviderConfig>,
): Promise<void> {
  const settings = await getOauthSettings();
  const cur = settings.providers[key];
  if (!isCustomKey(key) || !cur) throw new ServiceError("登录方式不存在", 404);
  if (typeof patch.label === "string") {
    const label = patch.label.trim();
    if (!label || label.length > 32) {
      throw new ServiceError("显示名称需 1~32 字", 422);
    }
    cur.label = label;
  }
  for (const f of ["authorizeUrl", "tokenUrl", "userInfoUrl"] as const) {
    if (typeof patch[f] === "string") {
      assertUrl(
        patch[f]!,
        f === "authorizeUrl"
          ? "授权地址"
          : f === "tokenUrl"
            ? "令牌地址"
            : "用户信息地址",
      );
      cur[f] = patch[f]!.trim();
    }
  }
  if (typeof patch.openIdField === "string") {
    if (!patch.openIdField.trim()) {
      throw new ServiceError("请填写用户唯一 ID 字段", 422);
    }
    cur.openIdField = patch.openIdField.trim();
  }
  if (typeof patch.clientId === "string") cur.clientId = patch.clientId.trim();
  if (typeof patch.clientSecret === "string" && patch.clientSecret) {
    cur.clientSecret = patch.clientSecret;
  }
  if (typeof patch.allowCreate === "boolean") cur.allowCreate = patch.allowCreate;
  if (typeof patch.mergeByEmail === "boolean") cur.mergeByEmail = patch.mergeByEmail;
  if (typeof patch.scope === "string") cur.scope = patch.scope.trim();
  if (typeof patch.nicknameField === "string") cur.nicknameField = patch.nicknameField.trim();
  if (typeof patch.avatarField === "string") cur.avatarField = patch.avatarField.trim();
  if (typeof patch.emailField === "string") cur.emailField = patch.emailField.trim();
  if (typeof patch.emailVerifiedField === "string")
    cur.emailVerifiedField = patch.emailVerifiedField.trim();
  if (patch.tokenMethod === "GET" || patch.tokenMethod === "POST")
    cur.tokenMethod = patch.tokenMethod;
  if (patch.tokenAuth === "basic" || patch.tokenAuth === "body")
    cur.tokenAuth = patch.tokenAuth;
  if (patch.userInfoAuth === "bearer" || patch.userInfoAuth === "query")
    cur.userInfoAuth = patch.userInfoAuth;
  if (typeof patch.enabled === "boolean") cur.enabled = patch.enabled;
  if (cur.enabled && (!cur.clientId || !cur.clientSecret)) {
    throw new ServiceError("启用前请填写客户端 ID 与密钥", 422);
  }
  await writeSettings(settings);
}

export async function removeCustomProvider(key: string): Promise<void> {
  if (!isCustomKey(key)) {
    throw new ServiceError("预设提供商不可删除", 422);
  }
  const settings = await getOauthSettings();
  if (!settings.providers[key]) {
    throw new ServiceError("登录方式不存在", 404);
  }
  await db.delete(oauthIdentities).where(eq(oauthIdentities.provider, key));
  delete settings.providers[key];
  await writeSettings(settings);
}

interface StateClaims {
  provider: string;
  nonce: string;

  bind?: number;

  redir?: string;
}

export async function signOAuthState(claims: StateClaims): Promise<string> {
  return new SignJWT({ oauth: true, ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(getSecret());
}

export async function verifyOAuthState(token: string): Promise<StateClaims> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    if (payload.oauth !== true || typeof payload.provider !== "string") {
      throw new Error("bad");
    }
    return {
      provider: payload.provider,
      nonce: String(payload.nonce ?? ""),
      bind: typeof payload.bind === "number" ? payload.bind : undefined,
      redir: typeof payload.redir === "string" ? payload.redir : undefined,
    };
  } catch {
    throw new ServiceError("登录状态已过期，请重新发起授权", 400);
  }
}

function safeRedirect(redir: string | undefined): string {
  if (redir && redir.startsWith("/") && !redir.startsWith("//")) return redir;
  return "/";
}

export interface StartResult {
  authorizeUrl: string;
  state: string;
}

export async function startOAuth(params: {
  key: string;
  origin: string;
  bindUserId?: number;
  redirect?: string;
}): Promise<StartResult> {
  await ensureMigrations();
  const { preset, config } = await resolveProvider(params.key);
  if (!config.enabled) throw new ServiceError("该登录方式未开启", 404);
  if (!config.clientId || !config.clientSecret) {
    throw new ServiceError("该登录方式配置不完整", 422);
  }
  const state = await signOAuthState({
    provider: params.key,
    nonce: crypto.randomBytes(16).toString("hex"),
    bind: params.bindUserId,
    redir: params.redirect ? safeRedirect(params.redirect) : undefined,
  });
  const redirectUri = `${params.origin}/api/oauth/${encodeURIComponent(params.key)}/callback`;
  let url: string;
  if (preset) {
    url = preset.buildAuthorizeUrl({
      clientId: config.clientId,
      redirectUri,
      state,
      scope: preset.scope,
    });
  } else {
    url = buildAuthorize(config.authorizeUrl!, {
      response_type: "code",
      client_id: config.clientId,
      redirect_uri: redirectUri,
      state,
      ...(config.scope ? { scope: config.scope } : {}),
    });
  }
  return { authorizeUrl: url, state };
}

function pickPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, k) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[k];
    return undefined;
  }, obj);
}

async function exchangeCustom(
  ctx: ExchangeContext,
): Promise<NormalizedProfile> {
  const { config, code, redirectUri, http } = ctx;
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  const params: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  };
  if (config.tokenAuth === "basic") {
    headers.Authorization =
      "Basic " +
      Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  } else {
    params.client_id = config.clientId;
    params.client_secret = config.clientSecret;
  }
  let res;
  if (config.tokenMethod === "GET") {
    res = await http(buildAuthorize(config.tokenUrl!, params));
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    res = await http(config.tokenUrl!, {
      method: "POST",
      headers,
      body: new URLSearchParams(params).toString(),
    });
  }
  const tok = asRecord(res.json());
  const accessToken = str(tok.access_token || tok.accessToken);
  if (!accessToken) {
    throw new ServiceError("令牌交换失败：未返回 access_token", 502);
  }

  const infoHeaders: Record<string, string> = { Accept: "application/json" };
  let infoUrl = config.userInfoUrl!;
  if (config.userInfoAuth === "query") {
    infoUrl = buildAuthorize(infoUrl, { access_token: accessToken });
  } else {
    infoHeaders.Authorization = `Bearer ${accessToken}`;
  }
  const info = (await http(infoUrl, { headers: infoHeaders })).json();

  const openId = str(pickPath(info, config.openIdField!));
  if (!openId) {
    throw new ServiceError("用户信息接口中未取到唯一 ID 字段", 502);
  }
  const email = config.emailField ? str(pickPath(info, config.emailField)) : "";
  const emailVerified = config.emailVerifiedField
    ? !!pickPath(info, config.emailVerifiedField)
    : false;
  return {
    openId,
    nickname:
      str(config.nicknameField ? pickPath(info, config.nicknameField) : "") ||
      "第三方用户",
    avatarUrl:
      str(config.avatarField ? pickPath(info, config.avatarField) : "") || null,
    email: email || null,
    emailVerified,
    raw: asRecord(info),
  };
}

export type OAuthResultMode = "login" | "merged" | "registered" | "bound";

export interface OAuthResult {
  mode: OAuthResultMode;
  user: SessionUser;

  needProfile: boolean;
  redirectTo: string;
}

function toSessionUser(row: {
  id: number;
  email: string | null;
  name: string;
  role: SessionUser["role"];
}): SessionUser {
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

function sanitizeName(raw: string): string {
  let n = (raw || "").trim().replace(/@/g, "").replace(/\s+/g, "");
  if (!n) n = `user${crypto.randomBytes(3).toString("hex")}`;
  return [...n].slice(0, 32).join("");
}

async function makeUniqueName(base: string): Promise<string> {
  const [taken] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.name}) = lower(${base})`);
  if (!taken) return base;
  for (let i = 1; i < 1000; i++) {
    const suffix = String(i);
    const candidate = [...base].slice(0, 32 - suffix.length).join("") + suffix;
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.name}) = lower(${candidate})`);
    if (!row) return candidate;
  }
  return `${base}_${crypto.randomBytes(2).toString("hex")}`.slice(0, 32);
}

async function touchIdentity(id: number, profile: NormalizedProfile): Promise<void> {
  await db
    .update(oauthIdentities)
    .set({
      nickname: profile.nickname,
      avatarUrl: profile.avatarUrl,
      raw: profile.raw,
      lastLoginAt: new Date(),
    })
    .where(eq(oauthIdentities.id, id));
}

async function touchUser(userId: number): Promise<void> {
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
}

async function attachIdentity(
  userId: number,
  key: string,
  profile: NormalizedProfile,
): Promise<void> {
  await db.insert(oauthIdentities).values({
    userId,
    provider: key,
    openId: profile.openId,
    nickname: profile.nickname,
    avatarUrl: profile.avatarUrl,
    raw: profile.raw,
    lastLoginAt: new Date(),
  });
}

export async function handleOAuthCallback(params: {
  key: string;
  code: string;
  state: string;
  stateCookie: string | null;
  origin: string;
  currentUserId?: number;
}): Promise<OAuthResult> {
  await ensureMigrations();
  const claims = await verifyOAuthState(params.state);
  if (!params.stateCookie || params.stateCookie !== params.state) {
    throw new ServiceError("授权校验失败：state 与浏览器状态不一致", 400);
  }
  if (claims.provider !== params.key) {
    throw new ServiceError("授权提供商与回调不一致", 400);
  }
  const { preset, config, label } = await resolveProvider(params.key);
  if (!config.enabled) throw new ServiceError("该登录方式未开启", 404);

  const redirectUri = `${params.origin}/api/oauth/${encodeURIComponent(params.key)}/callback`;
  const http = makeHttp();
  const ctx: ExchangeContext = { config, code: params.code, redirectUri, http };
  const profile = preset ? await preset.exchange(ctx) : await exchangeCustom(ctx);
  if (!profile.openId) {
    throw new ServiceError(`${label} 未返回账号标识`, 502);
  }

  const redirectTo = safeRedirect(claims.redir);

  if (claims.bind) {
    if (!params.currentUserId || params.currentUserId !== claims.bind) {
      throw new ServiceError("绑定会话已失效，请重新登录后再试", 403);
    }
    const [existing] = await db
      .select()
      .from(oauthIdentities)
      .where(
        and(
          eq(oauthIdentities.provider, params.key),
          eq(oauthIdentities.openId, profile.openId),
        ),
      );
    if (existing) {
      if (existing.userId === claims.bind) {
        return {
          mode: "bound",
          user: toSessionUser((await loadUser(claims.bind))!),
          needProfile: false,
          redirectTo: "/admin/account",
        };
      }
      throw new ServiceError("该第三方账号已被其他用户绑定", 409);
    }

    await attachIdentity(claims.bind, params.key, profile);
    const row = await loadUser(claims.bind);
    if (!row) throw new ServiceError("用户不存在", 404);
    return {
      mode: "bound",
      user: toSessionUser(row),
      needProfile: false,
      redirectTo: "/admin/account",
    };
  }

  const [identity] = await db
    .select()
    .from(oauthIdentities)
    .where(
      and(
        eq(oauthIdentities.provider, params.key),
        eq(oauthIdentities.openId, profile.openId),
      ),
    );

  if (identity) {
    const row = await loadUser(identity.userId);
    if (!row || row.status !== "active") {
      throw new ServiceError("账号已被停用，无法登录", 403);
    }
    await touchIdentity(identity.id, profile);
    await touchUser(row.id);
    return {
      mode: "login",
      user: toSessionUser(row),
      needProfile: false,
      redirectTo,
    };
  }

  if (profile.email && profile.emailVerified && config.mergeByEmail) {
    const [byEmail] = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = lower(${profile.email})`);
    if (byEmail) {
      if (byEmail.status !== "active") {
        throw new ServiceError("账号已被停用，无法登录", 403);
      }
      await attachIdentity(byEmail.id, params.key, profile);
      await touchUser(byEmail.id);
      return {
        mode: "merged",
        user: toSessionUser(byEmail),
        needProfile: false,
        redirectTo,
      };
    }
  }

  if (!config.allowCreate) {
    throw new ServiceError(
      "该第三方账号尚未关联本站用户，请先登录后在账号设置中绑定",
      403,
    );
  }

  const member = await getMemberSettings();
  const baseName = await makeUniqueName(sanitizeName(profile.nickname));
  let emailToUse: string | null = profile.email;
  let needProfile = !profile.email;
  if (profile.email) {
    const [emailTaken] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = lower(${profile.email})`);
    if (emailTaken) {
      emailToUse = null;
      needProfile = true;
    }
  }
  const [row] = await db
    .insert(users)
    .values({
      name: baseName,
      email: emailToUse,
      passwordHash: await hashPassword(crypto.randomBytes(24).toString("hex")),
      role: member.defaultRole,
      avatarUrl: profile.avatarUrl,
      emailVerified: !!emailToUse && profile.emailVerified,
    })
    .returning();
  await attachIdentity(row.id, params.key, profile);
  await addPasswordlessMark(row.id);
  return {
    mode: "registered",
    user: toSessionUser(row),
    needProfile,
    redirectTo,
  };
}

async function loadUser(id: number) {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      status: users.status,
    })
    .from(users)
    .where(eq(users.id, id));
  return row ?? null;
}

export interface UserIdentityView {
  id: number;
  key: string;
  label: string;
  color: string;
  nickname: string | null;
  avatarUrl: string | null;
  lastLoginAt: Date | null;
}

export async function listUserIdentities(
  userId: number,
): Promise<UserIdentityView[]> {
  const rows = await db
    .select()
    .from(oauthIdentities)
    .where(eq(oauthIdentities.userId, userId));
  return Promise.all(
    rows.map(async (r: any) => {
      let label = r.provider;
      let color = "#6366F1";
      try {
        const resolved = await resolveProvider(r.provider);
        label = resolved.label;
        color = resolved.color;
      } catch {

      }
      return {
        id: r.id,
        key: r.provider,
        label,
        color,
        nickname: r.nickname,
        avatarUrl: r.avatarUrl,
        lastLoginAt: r.lastLoginAt,
      };
    }),
  );
}

export async function unbindUserIdentity(
  userId: number,
  identityId: number,
): Promise<void> {
  const [ident] = await db
    .select()
    .from(oauthIdentities)
    .where(
      and(
        eq(oauthIdentities.id, identityId),
        eq(oauthIdentities.userId, userId),
      ),
    );
  if (!ident) throw new ServiceError("绑定不存在", 404);

  const rest = await db
    .select({ id: oauthIdentities.id })
    .from(oauthIdentities)
    .where(eq(oauthIdentities.userId, userId));
  const nopassword = await getPasswordlessSet();
  if (rest.length <= 1 && nopassword.has(userId)) {
    throw new ServiceError(
      "请先在账号设置中设置登录密码，再解绑最后一个第三方账号",
      422,
    );
  }
  await db.delete(oauthIdentities).where(eq(oauthIdentities.id, identityId));
}
