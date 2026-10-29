import crypto from "node:crypto";
import { getSecret } from "./auth.js";
import type { AdminSecurity } from "./security.js";
import { type Translate } from "./i18n.js";
import { b64url, makeUsedTracker, rnd, timingSafeEqualText } from "./captcha-common.js";

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

const used = makeUsedTracker();

function sign(bodyB64: string): string {
  return crypto.createHmac("sha256", signingKey()).update(bodyB64).digest("base64url");
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

/**
 * 5x7 bitmap glyphs for the builtin captcha, one string row per pixel row
 * ("#" = filled). Rendered as <rect> pixels, never as text - see captchaSvg.
 * Exported only for scripts/captcha-svg-vector.test.mts, which locks full
 * ALPHABET coverage and the 7x5 shape of every glyph.
 */
export const CAPTCHA_FONT: Record<string, string[]> = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  J: ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  N: ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"],
  X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  "3": ["#####", "...#.", "..#..", "...#.", "....#", "#...#", ".###."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": [".###.", "#....", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", "..#..", "..#..", "..#.."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "....#", ".###."],
};

/**
 * The builtin captcha image, drawn entirely from vector primitives.
 *
 * The previous renderer drew each answer character as an SVG <text> node with
 * a rotate() transform - the rotation only misled human eyes, while a bot
 * parsed the XML and read the answer straight out of the text node with zero
 * OCR (the whole point of the image defeated by a DOM query). Glyphs are now
 * 5x7 pixel matrices rendered as <rect>s inside a rotated <g>: there is no
 * text node and no character string anywhere in the output, so a solver must
 * actually recognize pixels (template-match or model) instead of parsing.
 *
 * Geometry: 4px pixels make a 20x28 glyph box (120x40 frame, glyphs centred
 * vertically, pitch (W-44)/(n-1) keeps the last glyph + rotation inside the
 * frame); rotation happens around the glyph centre so the pixel box cannot
 * clip. Noise paths/circles stay as before - they never carried the answer.
 * Consumed only as an <img src> (login-card/register render 120x38 boxes and
 * refresh on click), so nothing else depends on the SVG's internals.
 */
export function captchaSvg(code: string): string {
  const W = 120;
  const H = 40;
  const PX = 4;
  const GW = 5 * PX;
  const GH = 7 * PX;
  const chars = [...code];
  const n = chars.length;
  const step = n > 1 ? (W - 44) / (n - 1) : 0;
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
      const g = CAPTCHA_FONT[ch] ?? CAPTCHA_FONT["8"]!;
      const x = 14 + i * step + rnd(-2, 2);
      const y = (H - GH) / 2 + rnd(-2, 2);
      const rot = rnd(-20, 20);
      const fill = fills[crypto.randomInt(fills.length)];
      let px = "";
      for (let r = 0; r < 7; r++) {
        const row = g[r]!;
        for (let c = 0; c < 5; c++) {
          if (row[c] === "#") px += `<rect x="${c * PX}" y="${r * PX}" width="${PX}" height="${PX}"/>`;
        }
      }
      return `<g transform="translate(${x} ${y}) rotate(${rot} ${GW / 2} ${GH / 2})" fill="${fill}">${px}</g>`;
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
  t: Translate,
): string | null {
  const payload = parseToken(cookieToken);
  if (!payload || used.has(payload.j)) return t("api.captcha_wrong");
  if (!answer || !answer.trim()) return t("api.captcha_required");
  // Burn the token on the first non-empty attempt (right or wrong): the code is
  // single-use, so a wrong guess cannot be retried against the same token. The
  // login client already refreshes the captcha on every completed request
  // (login-card.js done()), so this costs no UX. An EMPTY answer returns
  // "required" without burning, so a user who simply hasn't typed yet can still
  // fill it in.
  used.add(payload.j, payload.e);
  if (normalizeAnswer(answer) !== payload.c) return t("api.captcha_wrong");
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

async function verifyRemote(
  sec: AdminSecurity,
  answer: string,
  t: Translate,
): Promise<string | null> {
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
    return t("api.captcha_unavailable");
  }

  const rule = sec.captchaVerifySuccess.trim();
  if (!rule) {
    const okFlag =
      res.ok &&
      data &&
      typeof data === "object" &&
      ((data as Record<string, unknown>).ok === true ||
        (data as Record<string, unknown>).success === true);
    return okFlag ? null : t("api.captcha_wrong");
  }
  const eq = rule.indexOf("=");
  const path = rule.slice(0, eq).trim();
  const expected = rule.slice(eq + 1).trim();
  const actual = path === "status" ? res.status : pickPath(data, path);
  return String(actual) === expected ? null : t("api.captcha_wrong");
}

export async function verifyLoginCaptcha(
  sec: AdminSecurity,
  answer: string | undefined,
  cookieToken: string | undefined,
  t: Translate,
): Promise<string | null> {
  if (!sec.captchaEnabled) return null;
  // body.captcha is untrusted JSON: a number/bool/object would throw on .trim()
  // and surface as a 500. Coerce non-strings to the "required" path.
  if (typeof answer !== "string" || !answer.trim()) return t("api.captcha_required");
  return sec.captchaMode === "custom"
    ? verifyRemote(sec, answer, t)
    : verifyBuiltin(answer, cookieToken, t);
}

export async function verifyCaptchaFor(
  sec: AdminSecurity,
  enabled: boolean,
  answer: string | undefined,
  cookieToken: string | undefined,
  t: Translate,
): Promise<string | null> {
  if (!enabled) return null;
  if (typeof answer !== "string" || !answer.trim()) return t("api.captcha_required");
  return sec.captchaMode === "custom"
    ? verifyRemote(sec, answer, t)
    : verifyBuiltin(answer, cookieToken, t);
}
