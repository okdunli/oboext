

import crypto from "node:crypto";
import { getSecret } from "./auth.js";
import type { AdminSecurity } from "./security.js";

export const CAPTCHA_COOKIE = "oboe_captcha";

export function readCaptchaCookie(req: Request): string | undefined {
  const header = req.headers.get("cookie") || "";
  const hit = header
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(CAPTCHA_COOKIE + "="));
  return hit ? decodeURIComponent(hit.slice(CAPTCHA_COOKIE.length + 1)) : undefined;
}

const VERSION = "oboe.login-captcha.v1";

const TTL_MS = 10 * 60 * 1000;

const USED_CAP = 5000;

const REMOTE_TIMEOUT_MS = 8000;

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

let keyCache: Buffer | null = null;
function signingKey(): Buffer {
  if (!keyCache) {
    keyCache = crypto
      .createHmac("sha256", Buffer.from(getSecret()))
      .update(VERSION)
      .digest();
  }
  return keyCache;
}

const used = new Map<string, number>();
let lastSweep = 0;

function sweepUsed(now: number) {
  if (now - lastSweep < 60_000 && used.size < USED_CAP) return;
  lastSweep = now;
  for (const [jti, exp] of used) {
    if (exp <= now) used.delete(jti);
  }
  if (used.size >= USED_CAP) {
    const sorted = [...used.entries()].sort((a, b) => a[1] - b[1]);
    for (const [jti] of sorted.slice(0, Math.ceil(USED_CAP / 10))) used.delete(jti);
  }
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(bodyB64: string): string {
  return crypto.createHmac("sha256", signingKey()).update(bodyB64).digest("base64url");
}

function timingSafeEqualText(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {

    const dummy = Buffer.alloc(ba.length);
    crypto.timingSafeEqual(ba, dummy);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function normalizeAnswer(raw: string): string {
  return raw
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
    )
    .replace(/\s+/g, "")
    .trim()
    .toUpperCase();
}

export function generateCaptchaCode(): string {
  let out = "";
  for (let i = 0; i < 4; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

function rnd(min: number, max: number): number {
  return min + crypto.randomInt(min, max + 1);
}

export function captchaSvg(code: string): string {
  const W = 120;
  const H = 40;
  const chars = [...code];
  const n = chars.length;
  const step = (W - 28) / (n - 1);
  const fills = ["#0f172a", "#1e3a8a", "#334155", "#7c2d12", "#164e63"];

  const noise: string[] = [];
  for (let i = 0; i < 5; i++) {
    const x1 = rnd(0, 18);
    const y1 = rnd(4, H - 4);
    const x2 = rnd(W - 18, W);
    const y2 = rnd(4, H - 4);
    noise.push(
      `<path d="M${x1} ${y1} Q ${rnd(30, W - 30)} ${rnd(2, H - 2)} ${x2} ${y2}" fill="none" stroke="#94a3b8" stroke-width="1" opacity="0.55"/>`,
    );
  }
  for (let i = 0; i < 24; i++) {
    noise.push(
      `<circle cx="${rnd(2, W - 2)} cy="${rnd(2, H - 2)} r="${(crypto.randomInt(6, 14) / 10).toFixed(1)}" fill="#cbd5e1" opacity="0.7"/>`,
    );
  }

  const glyphs = chars
    .map((ch, i) => {
      const x = 14 + i * step + rnd(-2, 2);
      const y = 28 + rnd(-2, 2);
      const rot = rnd(-20, 20);
      const fill = fills[crypto.randomInt(fills.length)];
      return `<text x="${x}" y="${y}" transform="rotate(${rot} ${x} ${y})" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="24" font-weight="700" fill="${fill}">${ch}</text>`;
    })
    .join("");

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" rx="7" fill="#eef2f7"/>` +
    noise.join("") +
    glyphs +
    `</svg>`
  );
}

export async function signCaptchaToken(code: string): Promise<string> {
  const payload = {
    c: code.toUpperCase(),
    j: crypto.randomUUID(),
    e: Date.now() + TTL_MS,
  };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

type TokenPayload = { c: string; j: string; e: number };

function parseToken(token: string | undefined | null): TokenPayload | null {
  if (!token) return null;
  try {
    const dot = token.lastIndexOf(".");
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    if (!timingSafeEqualText(sig, sign(body))) return null;
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      c?: unknown;
      j?: unknown;
      e?: unknown;
    };
    if (
      typeof p.c !== "string" ||
      typeof p.j !== "string" ||
      typeof p.e !== "number" ||
      p.e <= Date.now()
    )
      return null;
    return { c: p.c, j: p.j, e: p.e };
  } catch {
    return null;
  }
}

function verifyBuiltin(
  answer: string | undefined,
  cookieToken: string | undefined,
): string | null {
  const payload = parseToken(cookieToken);
  if (!payload || used.has(payload.j)) return "验证码不正确或已过期";
  if (!answer || !answer.trim()) return "请输入验证码";
  if (normalizeAnswer(answer) !== payload.c) return "验证码不正确或已过期";
  used.set(payload.j, payload.e);
  sweepUsed(Date.now());
  return null;
}

function parseHeaders(raw: string): Record<string, string> {
  const text = raw.trim();
  if (!text) return {};
  if (text.startsWith("{")) {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) out[k] = String(v);
    return out;
  }
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

function pickPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((cur, key) => {
    if (cur && typeof cur === "object") return (cur as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

async function verifyRemote(sec: AdminSecurity, answer: string): Promise<string | null> {
  const token = answer.trim();
  const url = sec.captchaVerifyUrl.replace(/\{\{\s*token\s*\}\}/g, encodeURIComponent(token));
  const method = sec.captchaVerifyMethod;
  const init: RequestInit = {
    method,
    headers: parseHeaders(sec.captchaVerifyHeaders),
    signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
  };
  if (method !== "GET" && sec.captchaVerifyBody.trim()) {

    const escaped = JSON.stringify(token).slice(1, -1);
    init.body = sec.captchaVerifyBody.replace(/\{\{\s*token\s*\}\}/g, escaped);
  }

  let res: Response;
  let data: unknown = null;
  try {
    res = await fetch(url, init);
    const text = await res.text();
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  } catch {
    return "验证码校验服务暂不可用，请稍后再试";
  }

  const rule = sec.captchaVerifySuccess.trim();
  if (!rule) {
    const okFlag =
      res.ok &&
      data &&
      typeof data === "object" &&
      ((data as Record<string, unknown>).ok === true ||
        (data as Record<string, unknown>).success === true);
    return okFlag ? null : "验证码不正确或已过期";
  }
  const eq = rule.indexOf("=");
  const path = rule.slice(0, eq).trim();
  const expected = rule.slice(eq + 1).trim();
  const actual = path === "status" ? res.status : pickPath(data, path);
  return String(actual) === expected ? null : "验证码不正确或已过期";
}

export async function verifyLoginCaptcha(
  sec: AdminSecurity,
  answer: string | undefined,
  cookieToken: string | undefined,
): Promise<string | null> {
  if (!sec.captchaEnabled) return null;
  if (!answer || !answer.trim()) return "请输入验证码";
  return sec.captchaMode === "custom"
    ? verifyRemote(sec, answer)
    : verifyBuiltin(answer, cookieToken);
}

export async function verifyCaptchaFor(
  sec: AdminSecurity,
  enabled: boolean,
  answer: string | undefined,
  cookieToken: string | undefined,
): Promise<string | null> {
  if (!enabled) return null;
  if (!answer || !answer.trim()) return "请输入验证码";
  return sec.captchaMode === "custom"
    ? verifyRemote(sec, answer)
    : verifyBuiltin(answer, cookieToken);
}
