// Shared low-level primitives for the two built-in captchas (login in
// captcha.ts, comment in comment-captcha.ts). They differed only in the VERSION
// string, the token payload shape and the SVG, but the plumbing below was
// byte-for-byte duplicated - so a fix to any of it had to be made twice and the
// copies could silently drift. One module, one copy.

import crypto from "node:crypto";

export const USED_CAP = 5000;

export function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** Constant-time text compare (length mismatch still burns a compare). */
export function timingSafeEqualText(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    const dummy = Buffer.alloc(ba.length);
    crypto.timingSafeEqual(ba, dummy);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

export function rnd(min: number, max: number): number {
  return min + crypto.randomInt(min, max + 1);
}

/**
 * A per-captcha single-use token tracker. Remembers spent jtis with their
 * expiry, sweeps expired entries at most once a minute, and caps total size
 * (evicting the soonest-to-expire tenth) so a long-lived process cannot grow it
 * without bound.
 */
export function makeUsedTracker() {
  const used = new Map<string, number>();
  let lastSweep = 0;
  return {
    has(jti: string): boolean {
      return used.has(jti);
    },
    add(jti: string, exp: number): void {
      used.set(jti, exp);
      const now = Date.now();
      if (now - lastSweep < 60_000 && used.size < USED_CAP) return;
      lastSweep = now;
      for (const [k, e] of used) {
        if (e <= now) used.delete(k);
      }
      if (used.size >= USED_CAP) {
        const sorted = [...used.entries()].sort((a, b) => a[1] - b[1]);
        for (const [k] of sorted.slice(0, Math.ceil(USED_CAP / 10))) used.delete(k);
      }
    },
  };
}
