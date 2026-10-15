// Authentication — ported verbatim in spirit from the original app (lib/auth.ts + the throttling half of lib/services/security-events.ts).
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
// Esbuild bundles server.js for a neutral platform: bcryptjs's runtime probes (`require("crypto")` and the browser-only `self.crypto`) both fail.
bcrypt.setRandomFallback((len: number) => Array.from(crypto.randomBytes(len)));
import { and, desc, eq, gt, or, sql } from "drizzle-orm";
import { db, ensureMigrations } from "./db.js";
import { users, securityEvents } from "./schema.js";
import { pruneSecurityEvents } from "./security-events.js";
import type { Role } from "./schema.js";
import { ServiceError } from "./errors.js";
import { getAdminSecurity } from "./security.js";
import { createLogger } from "./logger.js";
import { passwordError } from "./password-policy.js";
const log = createLogger("auth");

export const COOKIE_NAME = "cms_session";
/** Session lifetime in days. Also the CSRF token's, since it shadows this
 *  cookie - see csrf.ts, which imports it rather than repeating the number. */
export const SESSION_DAYS = 7;
const DEV_SECRET_PATH = path.resolve(process.cwd(), ".data", ".auth-secret");

export type SessionUser = {
  id: number;
  email: string | null;
  name: string;
  role: Role;
};

export function getSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (secret && secret.length >= 16) return new TextEncoder().encode(secret);
  if (process.env.NODE_ENV === "production") {
    log.warn(
      "[oboext] AUTH_SECRET is not set — deriving a stable secret from the database " +
        "connection string so sessions survive across serverless instances. Set AUTH_SECRET " +
        "in production for a non-derivable secret.",
    );
  }

  // Serverless filesystems (Vercel) are read-only, so the previous write-to-disk fallback generated a NEW random secret on every request.
  const stable = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || process.env.VERCEL_URL;
  if (stable) {
    return new TextEncoder().encode(crypto.createHash("sha256").update(stable).digest("hex"));
  }

  // Local dev without a database: persist once to disk if the FS is writable.
  try {
    fs.mkdirSync(path.dirname(DEV_SECRET_PATH), { recursive: true });
    if (!fs.existsSync(DEV_SECRET_PATH)) {
      fs.writeFileSync(DEV_SECRET_PATH, crypto.randomBytes(32).toString("hex"), {
        mode: 0o600,
      });
    }
    return new TextEncoder().encode(fs.readFileSync(DEV_SECRET_PATH, "utf8"));
  } catch {
    return new TextEncoder().encode(crypto.randomBytes(32).toString("hex"));
  }
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function signSession(user: SessionUser): Promise<string> {
  return new SignJWT({ id: user.id, email: user.email, name: user.name, role: user.role })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(getSecret());
}

/**
 * Set-Cookie header VALUE establishing the session.
 *
 * Split from sessionCookieValue() so the CSRF cookie can be derived from the
 * SAME token in one place: csrf.ts composes the pair, and a second call to
 * signSession() would mint a different token, leaving the two cookies
 * describing different sessions.
 */
export function sessionCookieValueFor(token: string): string {
  return [
    `${COOKIE_NAME}=${token}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${SESSION_DAYS * 24 * 60 * 60}`,
    ...(process.env.NODE_ENV === "production" ? ["Secure"] : []),
  ].join("; ");
}

/** Set-Cookie header VALUE establishing the session. */
export async function sessionCookieValue(user: SessionUser): Promise<string> {
  return sessionCookieValueFor(await signSession(user));
}

/** Set-Cookie header VALUE expiring the session. */
export function clearSessionCookieValue(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function readCookieToken(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (header) {
    const hit = header
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${COOKIE_NAME}=`));
    if (hit) return decodeURIComponent(hit.slice(COOKIE_NAME.length + 1));
  }
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

/** Validate a session token; re-reads users.status so a ban is instant. */
export async function verifyToken(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    await ensureMigrations();
    const id = payload.id as number;
    // Only session tokens carry the `id` claim; a 2FA challenge ticket
    // (sub = user id, twofa: true) must never authenticate a request.
    if (!Number.isInteger(id)) return null;
    const [row] = await db
      .select({ status: users.status, email: users.email, name: users.name, role: users.role })
      .from(users)
      .where(eq(users.id, id));
    if (!row || row.status !== "active") return null;
    return { id, email: row.email, name: row.name, role: row.role };
  } catch {
    return null;
  }
}

export async function getSessionFromRequest(req: Request): Promise<SessionUser | null> {
  const token = readCookieToken(req);
  return token ? verifyToken(token) : null;
}

/**
 * Validate credentials (email case-insensitive, or nickname), update
 * lastLoginAt, and fail indistinguishably for banned accounts.
 */
export async function verifyCredentials(
  account: string,
  password: string,
): Promise<SessionUser | null> {
  await ensureMigrations();
  const identifier = account.trim();
  const [row] = await db
    .select()
    .from(users)
    .where(
      identifier.includes("@")
        ? sql`lower(${users.email}) = lower(${identifier})`
        : sql`lower(${users.name}) = lower(${identifier})`,
    );
  if (!row) return null;
  const ok = await verifyPassword(password, row.passwordHash);
  if (!ok || row.status !== "active") return null;
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, row.id));
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

// ------------------------------------------------------------- login throttle

export const LOGIN_EVENTS = {
  SUCCESS: "login.success",
  FAIL: "login.fail",
  LOCKED: "login.locked",
  RESET_REQUEST: "password.reset.request",
  RESET_DONE: "password.reset.done",
} as const;

export async function assertLoginAllowed(account: string, ip: string | null): Promise<void> {
  const sec = await getAdminSecurity();
  if (!sec.throttleEnabled) return;
  const max = Math.max(1, sec.throttleMaxFailures);
  const windowMs = Math.max(1, sec.throttleWindowMinutes) * 60_000;
  const since = new Date(Date.now() - windowMs);
  const rows = await db
    .select({ createdAt: securityEvents.createdAt })
    .from(securityEvents)
    .where(
      and(
        eq(securityEvents.eventType, LOGIN_EVENTS.FAIL),
        gt(securityEvents.createdAt, since),
        or(
          account ? eq(securityEvents.account, account) : sql`false`,
          ip ? eq(securityEvents.ip, ip) : sql`false`,
        )!,
      ),
    )
    .orderBy(desc(securityEvents.id))
    .limit(max);
  if (rows.length >= max) {
    const unlockAt = rows[rows.length - 1].createdAt.getTime() + windowMs;
    const remainMs = unlockAt - Date.now();
    if (remainMs > 0) {
      const mins = Math.max(1, Math.ceil(remainMs / 60_000));
      throw new LoginThrottledError(`登录失败次数过多，请 ${mins} 分钟后再试`);
    }
  }
}

export async function recordLoginEvent(input: {
  eventType: string;
  userId?: number | null;
  account?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  try {
    await db.insert(securityEvents).values({
      eventType: input.eventType,
      userId: input.userId ?? null,
      account: input.account?.trim().slice(0, 120) || null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });
    // retention: drop records past OBOEXT_SECURITY_LOG_DAYS (no-op unless the
    // hourly throttle is due)
    await pruneSecurityEvents();
  } catch (e) {
    // audit failure must never block the login flow
    log.error("[security-events] write failed:", e);
  }
}

export class LoginThrottledError extends Error {}

// ------------------------------------------------------------- first-run admin

/**
 * Whether the install has been initialized (at least one user row).
 *
 * Memoized on globalThis for two reasons. Correctness: the answer only ever
 * flips false -> true, and it flips exactly once - inside createFirstAdmin.
 * Cost: a bare `count(*)` on every request is a wasted round trip on the hot
 * path, and the middleware asks this question for EVERY public page render
 * (that is what sends a fresh install to /admin/setup instead of showing an
 * empty blog). One promise per process, reset by createFirstAdmin so the
 * redirect cannot outlive the install it was protecting.
 */
export function hasAnyUser(): Promise<boolean> {
  const g = globalThis as unknown as { __oboeHasAnyUser?: Promise<boolean> };
  if (!g.__oboeHasAnyUser) {
    g.__oboeHasAnyUser = (async () => {
      await ensureMigrations();
      const [row] = await db.select({ count: sql<number>`count(*)` }).from(users);
      return Number(row?.count ?? 0) > 0;
    })().catch((e) => {
      // A failed probe must not be cached as "empty": that would lock a live
      // install behind the setup wall until the process restarts.
      g.__oboeHasAnyUser = undefined;
      throw e;
    });
  }
  return g.__oboeHasAnyUser;
}

export async function createFirstAdmin(input: {
  email: string;
  name: string;
  password: string;
}): Promise<SessionUser> {
  if (await hasAnyUser()) throw new Error("系统已初始化，无法重复创建管理员");
  const email = (input.email || "").trim();
  const name = (input.name || "").trim();
  if (!email || !name) throw new ServiceError("邮箱和昵称不能为空", 422);
  if (!EMAIL_RE.test(email) || email.length > 120)
    throw new ServiceError("邮箱格式不正确", 422);
  if (name.length > 64) throw new ServiceError("昵称长度不能超过 64 个字符", 422);
  if (!input.password) throw new ServiceError("密码不能为空", 422);
  const pwErr = passwordError(input.password, { email, name });
  if (pwErr) throw pwErr;
  const [row] = await db
    .insert(users)
    .values({
      email,
      name,
      passwordHash: await hashPassword(input.password),
      role: "admin",
    })
    .returning();
  // The memoized probe answered false a moment ago; drop it so the next
  // hasAnyUser() reads the row we just inserted instead of replaying the
  // pre-install answer (which would keep bouncing the owner to /admin/setup).
  (globalThis as unknown as { __oboeHasAnyUser?: Promise<boolean> }).__oboeHasAnyUser = undefined;
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

export function clientIp(req: Request): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  return (
    (fwd ? fwd.split(",")[0] : req.headers.get("x-real-ip"))?.trim() || null
  );
}

export function clientUa(req: Request): string | null {
  return (req.headers.get("user-agent") || "").slice(0, 500) || null;
}

// ------------------------------------------------- contact lookup + reset
// Ports of lib/services/users.ts's contact helpers — the email/SMS code
// login, password reset and (later) member registration all resolve a user
// by account or by channel + contact target.

export async function findUserByAccount(account: string) {
  const identifier = account.trim();
  if (!identifier) return null;
  const [row] = await db
    .select()
    .from(users)
    .where(
      identifier.includes("@")
        ? sql`lower(${users.email}) = lower(${identifier})`
        : sql`lower(${users.name}) = lower(${identifier})`,
    );
  return row ?? null;
}

/** Email is case-insensitive; phone matches exactly (already normalised). */
export async function findUserByContact(
  channel: "email" | "sms",
  target: string,
) {
  const [row] = await db
    .select()
    .from(users)
    .where(
      channel === "email"
        ? sql`lower(${users.email}) = lower(${target})`
        : sql`${users.phone} = ${target}`,
    );
  return row ?? null;
}

export async function resetUserPassword(
  userId: number,
  newPassword: string,
): Promise<void> {
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(newPassword), updatedAt: new Date() })
    .where(eq(users.id, userId));
}

/** Stamp lastLoginAt (code login / 2FA redemption paths). */
export async function touchLastLogin(userId: number): Promise<void> {
  await ensureMigrations();
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_LOCAL_RE = /^1[3-9]\d{9}$/;
const PHONE_INTL_RE = /^\+\d{6,15}$/;

/**
 * Validate + normalise a contact target (email or CN mobile / E.164),
 * shared by send-code / login-code / register so the rules cannot drift.
 */
export function normalizeContactTarget(channel: "email" | "sms", raw: string): string {
  const v = String(raw ?? "").trim();
  if (channel === "email") {
    if (!EMAIL_RE.test(v) || v.length > 120) {
      throw new ServiceError("邮箱格式不正确", 422);
    }
    return v;
  }
  const p = v.replace(/[\s-]/g, "");
  if (!PHONE_LOCAL_RE.test(p) && !PHONE_INTL_RE.test(p)) {
    throw new ServiceError("手机号格式不正确", 422);
  }
  return p;
}

// ------------------------------------------------------- 2FA challenge ticket
// Password (or code) login succeeded but a second-factor plugin wants a
// dynamic code: instead of a session we issue a 10-minute ticket that only
// /api/auth/login-2fa can redeem (purpose claim + user id, HS256).

const CHALLENGE_MINUTES = 10;

export async function signChallengeTicket(user: SessionUser): Promise<string> {
  // Claim shape mirrors the original: { twofa: true } + sub = user id, and
  // deliberately NO `id` claim — a challenge ticket must never double as a
  // session cookie (that would skip the second factor entirely).
  return new SignJWT({ twofa: true })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(user.id))
    .setIssuedAt()
    .setExpirationTime(`${CHALLENGE_MINUTES}m`)
    .sign(getSecret());
}

/** Returns the ticket's user, or null when invalid/expired/not a 2FA ticket. */
export async function verifyChallengeTicket(ticket: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(ticket, getSecret());
    if (payload.twofa !== true || !payload.sub) return null;
    const id = Number(payload.sub);
    if (!Number.isInteger(id)) return null;
    // Re-read the row so a banned/deleted account cannot finish the challenge.
    const [row] = await db
      .select({ status: users.status, email: users.email, name: users.name, role: users.role })
      .from(users)
      .where(eq(users.id, id));
    if (!row || row.status !== "active") return null;
    return { id, email: row.email, name: row.name, role: row.role };
  } catch {
    return null;
  }
}
