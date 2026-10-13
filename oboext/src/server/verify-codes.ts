

import crypto from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "./db.js";
import { verifyCodes } from "./schema.js";
import { getSecret } from "./auth.js";
import { ServiceError } from "./admin.js";

const TTL_MS = 10 * 60 * 1000;
const RESEND_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const IP_HOUR_CAP = 20;

export type CodeChannel = "email" | "sms";
export type CodePurpose = "register" | "reset" | "bind" | "login";

function hashCode(code: string): string {
  return crypto.createHmac("sha256", Buffer.from(getSecret())).update(code).digest("hex");
}

export interface IssueCodeInput {
  channel: CodeChannel;
  target: string;
  purpose: CodePurpose;
  ip?: string | null;
}

export async function issueCode(input: IssueCodeInput): Promise<string> {
  const now = new Date();

  const [live] = await db
    .select({ createdAt: verifyCodes.createdAt })
    .from(verifyCodes)
    .where(
      and(
        eq(verifyCodes.target, input.target),
        eq(verifyCodes.channel, input.channel),
        eq(verifyCodes.purpose, input.purpose),
        isNull(verifyCodes.consumedAt),
      ),
    )
    .orderBy(desc(verifyCodes.id))
    .limit(1);
  if (live && now.getTime() - live.createdAt.getTime() < RESEND_MS) {
    throw new ServiceError("发送太频繁，请 1 分钟后再试");
  }

  if (input.ip) {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(verifyCodes)
      .where(
        and(
          eq(verifyCodes.ip, input.ip),
          gt(verifyCodes.createdAt, new Date(now.getTime() - 60 * 60 * 1000)),
        ),
      );
    if ((row?.n ?? 0) >= IP_HOUR_CAP) {
      throw new ServiceError("请求过于频繁，请稍后再试");
    }
  }

  await db
    .update(verifyCodes)
    .set({ consumedAt: now })
    .where(
      and(
        eq(verifyCodes.target, input.target),
        eq(verifyCodes.channel, input.channel),
        eq(verifyCodes.purpose, input.purpose),
        isNull(verifyCodes.consumedAt),
      ),
    );

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  await db.insert(verifyCodes).values({
    target: input.target,
    channel: input.channel,
    purpose: input.purpose,
    codeHash: hashCode(code),
    expiresAt: new Date(now.getTime() + TTL_MS),
    ip: input.ip ?? null,
  });
  return code;
}

export async function invalidateLatestCode(input: IssueCodeInput): Promise<void> {
  const [row] = await db
    .select({ id: verifyCodes.id })
    .from(verifyCodes)
    .where(
      and(
        eq(verifyCodes.target, input.target),
        eq(verifyCodes.channel, input.channel),
        eq(verifyCodes.purpose, input.purpose),
        isNull(verifyCodes.consumedAt),
      ),
    )
    .orderBy(desc(verifyCodes.id))
    .limit(1);
  if (row) {
    await db
      .update(verifyCodes)
      .set({ consumedAt: new Date() })
      .where(eq(verifyCodes.id, row.id));
  }
}

export interface VerifyCodeInput {
  channel: CodeChannel;
  target: string;
  purpose: CodePurpose;
  code: string;
}

export async function verifyCode(input: VerifyCodeInput): Promise<true> {
  const value = input.code.trim();
  if (!/^\d{4,8}$/.test(value)) {
    throw new ServiceError("验证码错误或已过期");
  }
  const [row] = await db
    .select()
    .from(verifyCodes)
    .where(
      and(
        eq(verifyCodes.target, input.target),
        eq(verifyCodes.channel, input.channel),
        eq(verifyCodes.purpose, input.purpose),
        isNull(verifyCodes.consumedAt),
      ),
    )
    .orderBy(desc(verifyCodes.id))
    .limit(1);

  if (!row || row.expiresAt.getTime() < Date.now()) {
    throw new ServiceError("验证码错误或已过期");
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    throw new ServiceError("验证码错误次数过多，请重新获取");
  }

  if (row.codeHash !== hashCode(value)) {
    await db
      .update(verifyCodes)
      .set({ attempts: sql`${verifyCodes.attempts} + 1` })
      .where(eq(verifyCodes.id, row.id));
    throw new ServiceError("验证码错误或已过期");
  }

  await db
    .update(verifyCodes)
    .set({ consumedAt: new Date() })
    .where(eq(verifyCodes.id, row.id));
  return true;
}
