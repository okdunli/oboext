

import crypto from "node:crypto";

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input
    .toUpperCase()
    .replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32_ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateSecret(bytes = 20): string {
  return base32Encode(crypto.randomBytes(bytes));
}

export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", secret).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const bin =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(bin % 1_000_000).padStart(6, "0");
}

const PERIOD = 30;
const DIGITS = 6;

export function totp(secretB32: string, atMs = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / PERIOD);
  return hotp(base32Decode(secretB32), counter);
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function verifyTotp(
  secretB32: string,
  token: string,
  window = 1,
  atMs = Date.now(),
): boolean {
  const code = String(token ?? "").trim();
  if (!/^\d{6}$/.test(code)) return false;
  const key = base32Decode(secretB32);
  const counter = Math.floor(atMs / 1000 / PERIOD);
  for (let drift = -window; drift <= window; drift++) {
    if (safeEqual(hotp(key, counter + drift), code)) return true;
  }
  return false;
}

export function buildOtpauthUrl(label: string, secretB32: string, issuer: string): string {
  const account = encodeURIComponent(`${issuer}:${label}`);
  const params = new URLSearchParams({
    secret: secretB32.replace(/=+$/g, ""),
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(PERIOD),
  });
  return `otpauth://totp/${account}?${params.toString()}`;
}

const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateRecoveryCode(): string {
  let raw = "";
  for (let i = 0; i < 8; i++) {
    raw += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function generateRecoveryCodes(n = 20): string[] {
  return Array.from({ length: n }, () => generateRecoveryCode());
}

export function normalizeRecoveryCode(code: string): string {
  return String(code ?? "")
    .toUpperCase()
    .replace(/[^A-Z2-9]/g, "");
}
