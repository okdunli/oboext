// Cross-site request forgery protection. Recomputing the HMAC from the session token means an injected cookie cannot produce a value the server accepts.
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

// Cookie holding the token.
export const CSRF_COOKIE_NAME = "cms_csrf";

/** Header the token is echoed in. */
export const CSRF_HEADER = "x-csrf-token";

// Token lifetime in days — the session's, because it shadows that cookie.
const CSRF_DAYS = SESSION_DAYS;

// The token for a given session token.
export function csrfTokenFor(sessionToken: string): string {
  return crypto
    .createHmac("sha256", Buffer.from(getSecret()))
    .update("csrf:" + sessionToken)
    .digest("base64url");
}

// Every Set-Cookie value a fresh login must send: the session, and the CSRF token derived from that SAME session token.
export async function sessionCookiePair(user: SessionUser): Promise<string[]> {
  const token = await signSession(user);
  return [sessionCookieValueFor(token), csrfCookieValue(token)];
}

/**
 * Attach Set-Cookie values to a response.
 *
 * A plain object field (`headers: { "set-cookie": values }`) is WRONG for more
 * than one cookie: the runtime collapses the array into a single comma-joined
 * header, and a browser then parses only the first name=value pair - every
 * cookie after the first is silently dropped (Rosezm BUG.md entry Y: this bit
 * every login path until 0.2.8's framework 0.1.8 upgrade surfaced it).
 * Headers.append keeps one header per cookie, which is what the spec wants.
 */
export function withCookies(res: Response, values: string[]): Response {
  for (const v of values) res.headers.append("set-cookie", v);
  return res;
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

  // Both halves are required and must be EQUAL. The header is what proves the
  // caller could read the cookie; the cookie is what the HMAC is checked
  // against. Accepting a header with no cookie read would make the header the
  // whole defence — and a forged request sets a header freely.
  const cookie = readCsrfCookie(req);
  if (!cookie) return { ok: false, reason: "no-token" };
  const presented = req.headers.get(CSRF_HEADER);
  if (!presented) return { ok: false, reason: "no-token" };
  if (presented !== cookie) return { ok: false, reason: "mismatch" };

  const expected = csrfTokenFor(session);
  // timingSafeEqual needs two equal-length buffers or it throws, so the
  // length check is part of the comparison, not a shortcut around it.
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

/**
 * Set-Cookie value re-minting the token for a session that somehow lost its
 * csrf half (a session established before the token shipped, a cleared cookie
 * while the session survived). The token is derived from the session the
 * server itself just validated, so re-minting is exactly as safe as the login
 * that first paired them. Null when there is nothing to heal: no session, or
 * the cookie is present and the rejection is a genuine mismatch/invalid.
 */
export function selfHealCsrfCookie(req: Request): string | null {
  const session = readSessionCookie(req);
  if (!session) return null;
  if (readCsrfCookie(req)) return null;
  return csrfCookieValue(session);
}
