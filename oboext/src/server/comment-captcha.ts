import crypto from "node:crypto";
import { getSecret } from "./auth.js";

const VERSION = "oboe.comment-captcha.v1";

const TTL_MS = 10 * 60 * 1000;

const USED_CAP = 5000;

let keyCache: Buffer | null = null;
function signingKey(): Buffer {
  if (!keyCache) {
    keyCache = crypto
      .createHmac("sha256", getSecret())
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
    .replace(/[０-９]/g, (ch) => String(ch.charCodeAt(0) - 0xff10))
    .replace(/\s+/g, "")
    .trim();
}

function rnd(min: number, max: number): number {
  return min + crypto.randomInt(min, max + 1);
}

function makePuzzle(): { text: string; answer: number } {
  const a = rnd(1, 9);
  const b = rnd(1, 9);
  if (crypto.randomInt(2) === 0) return { text: `${a}+${b}=?`, answer: a + b };
  const [x, y] = a >= b ? [a, b] : [b, a];
  return { text: `${x}-${y}=?`, answer: x - y };
}

function renderSvg(text: string): string {
  const W = 120;
  const H = 44;
  const chars = [...text];
  const n = chars.length;
  const step = (W - 26) / (n - 1);
  const fills = ["#0f172a", "#1e3a8a", "#334155", "#7c2d12", "#164e63"];

  const noise: string[] = [];
  for (let i = 0; i < 5; i++) {
    const x1 = rnd(0, 20);
    const y1 = rnd(4, H - 4);
    const x2 = rnd(W - 20, W);
    const y2 = rnd(4, H - 4);
    const cx = rnd(30, W - 30);
    noise.push(
      `<path d="M${x1} ${y1} Q ${cx} ${rnd(2, H - 2)} ${x2} ${y2}" fill="none" stroke="#94a3b8" stroke-width="1" opacity="0.55"/>`,
    );
  }
  for (let i = 0; i < 26; i++) {
    noise.push(
      `<circle cx="${rnd(2, W - 2)}" cy="${rnd(2, H - 2)}" r="${(crypto.randomInt(6, 14) / 10).toFixed(1)}" fill="#cbd5e1" opacity="0.7"/>`,
    );
  }

  const glyphs = chars
    .map((ch, i) => {
      const x = 13 + i * step + rnd(-2, 2);
      const y = 30 + rnd(-3, 3);
      const rot = rnd(-18, 18);
      const fill = fills[crypto.randomInt(fills.length)];
      return `<text x="${x}" y="${y}" transform="rotate(${rot} ${x} ${y})" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="23" font-weight="700" fill="${fill}">${ch}</text>`;
    })
    .join("");

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" rx="8" fill="#eef2f7"/>` +
    noise.join("") +
    glyphs +
    `</svg>`
  );
}

export type CommentCaptchaChallenge = { token: string; svg: string };

export function createCommentCaptcha(): CommentCaptchaChallenge {
  const puzzle = makePuzzle();
  const now = Date.now();
  const payload = { v: puzzle.answer, j: crypto.randomUUID(), e: now + TTL_MS };
  const body = b64url(JSON.stringify(payload));
  return { token: `${body}.${sign(body)}`, svg: renderSvg(puzzle.text) };
}

type DecodedCaptcha = { v: number; j: string; e: number };

/** Verify the HMAC + shape + expiry WITHOUT consuming the token. Returns the
 *  decoded payload so callers can additionally compare the answer and/or mark
 *  the jti used. Returns null when the token is malformed/forged/expired. */
function decodeCaptcha(token: string): DecodedCaptcha | null {
  try {
    if (!token) return null;
    const dot = token.lastIndexOf(".");
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    if (!timingSafeEqualText(sig, sign(body))) return null;

    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      v?: unknown;
      j?: unknown;
      e?: unknown;
    };
    if (
      typeof payload.v !== "number" ||
      typeof payload.j !== "string" ||
      typeof payload.e !== "number"
    )
      return null;
    if (payload.e <= Date.now()) return null;
    return { v: payload.v, j: payload.j, e: payload.e };
  } catch {
    return null;
  }
}

/** Non-consuming answer check: signature + expiry + correctness only. Safe to
 *  call from a live "is it right?" probe (the client re-checks on blur) because
 *  it neither reads nor writes the `used` set — the token stays valid for the
 *  real submit-time verifyCommentCaptcha(). */
export function validateCommentCaptcha(token: string, answer: string): boolean {
  const decoded = decodeCaptcha(token);
  if (!decoded || !answer) return false;
  return normalizeAnswer(answer) === String(decoded.v);
}

export function verifyCommentCaptcha(token: string, answer: string): boolean {
  const decoded = decodeCaptcha(token);
  if (!decoded || !answer) return false;

  const now = Date.now();
  if (used.has(decoded.j)) return false;
  if (normalizeAnswer(answer) !== String(decoded.v)) return false;

  used.set(decoded.j, decoded.e);
  sweepUsed(now);
  return true;
}
