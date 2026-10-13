/**
 * Authentication — ported verbatim in spirit from the original
 * (lib/auth.ts + the throttling half of lib/services/security-events.ts).
 *
 * jose HS256 sessions (7d), bcryptjs cost-10 passwords, a per-PGlite-dir
 * persisted secret at .data/.auth-secret, and a security_events sliding-window
 * login throttle (5 failures / 15 min, same account OR same IP).
 *
 * Route handlers receive raw Requests, so cookies arrive as
 * plain header strings: sessionCookieHeader()/clearSessionCookieHeader() build
 * Set-Cookie values the API routes attach to their Response.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
bcrypt.setRandomFallback((len: number) => Array.from(crypto.randomBytes(len)));
import { and, desc, eq, gt, or, sql } from "drizzle-orm";
import { db, ensureMigrations } from "./db.js";
import { users, securityEvents } from "./schema.js";
import type { Role } from "./schema.js";
import { ServiceError } from "./errors.js";

export const COOKIE_NAME = "cms_session";
const SESSION_DAYS = 7;
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
    console.warn(
      "[oboext] AUTH_SECRET is not set — using an auto-generated local secret. " +
        "Set AUTH_SECRET in production to keep sessions stable across instances.",
    );
  }
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

/** Set-Cookie header VALUE establishing the session. */
export async function sessionCookieValue(user: SessionUser): Promise<string> {
  const token = await signSession(user);
  return [
    `${COOKIE_NAME}=${token}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${SESSION_DAYS * 24 * 60 * 60}`,
    ...(process.env.NODE_ENV === "production" ? ["Secure"] : []),
  ].join("; ");
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

const THROTTLE_MAX = 5;
const THROTTLE_WINDOW_MS = 15 * 60_000;

export const LOGIN_EVENTS = {
  SUCCESS: "login.success",
  FAIL: "login.fail",
  LOCKED: "login.locked",
  RESET_REQUEST: "password.reset.request",
  RESET_DONE: "password.reset.done",
} as const;

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
  } catch (e) {
    console.error("[security-events] write failed:", e);
  }
}

/** Sliding-window failure gate: 5 fails (same account or IP) within 15 min. */
export async function assertLoginAllowed(account: string, ip: string | null): Promise<void> {
  const since = new Date(Date.now() - THROTTLE_WINDOW_MS);
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
    .limit(THROTTLE_MAX);
  if (rows.length >= THROTTLE_MAX) {
    const unlockAt = rows[rows.length - 1].createdAt.getTime() + THROTTLE_WINDOW_MS;
    const remainMs = unlockAt - Date.now();
    if (remainMs > 0) {
      const mins = Math.max(1, Math.ceil(remainMs / 60_000));
      throw new LoginThrottledError(`登录失败次数过多，请 ${mins} 分钟后再试`);
    }
  }
}

export class LoginThrottledError extends Error {}

export async function hasAnyUser(): Promise<boolean> {
  await ensureMigrations();
  const [row] = await db.select({ count: sql<number>`count(*)` }).from(users);
  return Number(row?.count ?? 0) > 0;
}

export async function createFirstAdmin(input: {
  email: string;
  name: string;
  password: string;
}): Promise<SessionUser> {
  if (await hasAnyUser()) throw new Error("系统已初始化，无法重复创建管理员");
  const [row] = await db
    .insert(users)
    .values({
      email: input.email,
      name: input.name,
      passwordHash: await hashPassword(input.password),
      role: "admin",
    })
    .returning();
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

const CHALLENGE_MINUTES = 10;

export async function signChallengeTicket(user: SessionUser): Promise<string> {
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
