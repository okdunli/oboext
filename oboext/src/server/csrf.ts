/**
 * Cross-site request forgery protection.
 *
 * The session cookie is `SameSite=Lax`, which already blocks the classic
 * cross-site POST of an HTML form — but Lax only stops the cookie on
 * *cross-site* requests, and it says nothing about a same-site attacker
 * (a compromised or user-controlled subdomain), about a client that treats
 * "the cookie is present" as authorisation for anything the origin offers, or
 * about the day the cookie policy is relaxed for some other reason. A token is
 * the part that does not depend on the browser's cookie policy at all.
 *
 * Two properties make this cheap here:
 *
 *  1. The token is DERIVED from the session token, not stored. There is no
 *     table to consult, no second cookie that can expire on a different
 *     schedule than the session it protects, and no way for the two to drift.
 *     `HMAC(secret, sessionToken)` is deterministic, so the middleware
 *     recomputes the expected value from the cookie it already read.
 *
 *  2. Verification is HMAC-based, not equality-only. Equality alone is the
 *     textbook double-submit cookie, and it fails against cookie INJECTION:
 *     an attacker who can set `cms_csrf` on the victim's browser (through a
 *     sibling subdomain, for instance) sets it to a value they know and then
 *     sends that same value in the header. Recomputing the HMAC from the
 *     session token means an injected cookie cannot produce a value the server
 *     accepts.
 *
 * The token travels in a NON-HttpOnly cookie so scripts can read it, and is
 * echoed in the `X-CSRF-Token` header. That pairing is what makes the attack
 * fail: a cross-origin page can cause the cookie to be SENT, but the same
 * origin policy stops it from READING the cookie, so it cannot echo the value
 * into a header.
 */
import crypto from "crypto";
import {
  getSecret,
  COOKIE_NAME,
  SESSION_DAYS,
  signSession,
  sessionCookieValueFor,
  clearSessionCookieValue,
  type SessionUser,
} from "./auth.js";

/**
 * Cookie holding the token. Deliberately not HttpOnly — the whole point is
 * that same-origin JavaScript can read it and echo it into a header. It is
 * scoped to Path=/ and SameSite=Lax so it is not readable from a page on
 * another origin and is not attached to cross-site requests at all.
 */
export const CSRF_COOKIE_NAME = "cms_csrf";

/** Header the token is echoed in. */
export const CSRF_HEADER = "x-csrf-token";

/**
 * Token lifetime in days — the session's, because it shadows that cookie.
 * Imported rather than repeated so the two can never drift; a token that
 * outlives its session is not a security problem (it simply stops matching,
 * since it is derived from the session token) but it is confusing to debug.
 */
const CSRF_DAYS = SESSION_DAYS;

/**
 * The token for a given session token.
 *
 * Derived, not random: an attacker who cannot read the cookie cannot predict
 * it, an attacker who CAN write the cookie still cannot produce a valid one
 * (the HMAC key is the server secret), and the server needs no storage to
 * check it. The `csrf:` domain separator keeps this value from ever being
 * mistaken for — or colliding with — anything derived from the raw session
 * token.
 */
export function csrfTokenFor(sessionToken: string): string {
  return crypto
    .createHmac("sha256", Buffer.from(getSecret()))
    .update("csrf:" + sessionToken)
    .digest("base64url");
}

/**
 * Every Set-Cookie value a fresh login must send: the session, and the CSRF
 * token derived from that SAME session token.
 *
 * One function so no login path can establish a session without its token.
 * There are seven such paths (password, 2FA, code, registration, first-run
 * setup, OAuth callback, self-service profile update) and the failure mode of
 * a missed one is a locked-out user whose every write returns 400 — which
 * looks like a broken app rather than a missing defence, so it is worth
 * making the pairing impossible to forget.
 *
 * Returns an array because that is what `headers: { "set-cookie": [...] }`
 * expects. A single joined string is the classic mistake here: it produces one
 * malformed cookie, not two cookies, and the second one is silently dropped.
 */
export async function sessionCookiePair(user: SessionUser): Promise<string[]> {
  const token = await signSession(user);
  return [sessionCookieValueFor(token), csrfCookieValue(token)];
}

/** Every Set-Cookie value a logout must send. */
export function clearCookiePair(): string[] {
  return [clearSessionCookieValue(), clearCsrfCookieValue()];
}

/** Set-Cookie header VALUE establishing the token. */
export function csrfCookieValue(sessionToken: string): string {
  return [
    `${CSRF_COOKIE_NAME}=${csrfTokenFor(sessionToken)}`,
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${CSRF_DAYS * 24 * 60 * 60}`,
    ...(process.env.NODE_ENV === "production" ? ["Secure"] : []),
  ].join("; ");
}

/** Set-Cookie header VALUE expiring the token. */
export function clearCsrfCookieValue(): string {
  return `${CSRF_COOKIE_NAME}=; SameSite=Lax; Path=/; Max-Age=0`;
}

/** The raw cookie token, or null when absent. */
function readCsrfCookie(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  const hit = header
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${CSRF_COOKIE_NAME}=`));
  return hit ? hit.slice(CSRF_COOKIE_NAME.length + 1) : null;
}

/** The session token as sent, or null. Only the cookie form counts: a Bearer
 *  token is not attached automatically by the browser, so it is not a CSRF
 *  vector and must not be asked for a token it has no way to obtain. */
function readSessionCookie(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  const hit = header
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE_NAME}=`));
  return hit ? decodeURIComponent(hit.slice(COOKIE_NAME.length + 1)) : null;
}

/** Why a request failed the check, for the server log. Never sent to the
 *  caller: a distinct message per failure mode tells an attacker which part
 *  of the defence he is up against. "no-session" is deliberately absent — a
 *  request with no session cookie is out of scope and returns ok. */
type CsrfFailure = "no-token" | "mismatch" | "invalid";

/** Whether the request carries the session cookie at all. Read this rather
 *  than testing `ok`, because a guest write is ALLOWED — it is out of scope,
 *  not a pass and not a failure. */
export function needsCsrf(req: Request): boolean {
  return readSessionCookie(req) !== null;
}

/**
 * Whether this request may perform a state change.
 *
 * Returns `{ ok: true }` for a request with no session cookie. That is not a
 * loophole, it is the scope of the defence: CSRF is about credentials the
 * browser attaches on its own, so a request that carries none has nothing to
 * forge and the entire guest surface — comments, likes, login, registration,
 * captcha, GraphQL over Bearer — needs no token and no exemption list.
 *
 * `ok: false` means a session cookie WAS present and the request failed to
 * prove same-origin. It carries the reason for the server log only; the
 * caller must not report it, because naming the failing check tells an
 * attacker which half of the defence is left.
 *
 * Callers still enforce their own authorisation; this only establishes that
 * the request is not a forgery.
 */
export function checkCsrf(req: Request): { ok: true } | { ok: false; reason: CsrfFailure } {
  const session = readSessionCookie(req);
  if (!session) return { ok: true };

  const cookie = readCsrfCookie(req);
  if (!cookie) return { ok: false, reason: "no-token" };
  const presented = req.headers.get(CSRF_HEADER);
  if (!presented) return { ok: false, reason: "no-token" };
  if (presented !== cookie) return { ok: false, reason: "mismatch" };

  const expected = csrfTokenFor(session);
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true };
}

/** Methods that cannot change state and so are never checked. */
export function isSafeMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS";
}
