

import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db, ensureMigrations } from "./db.js";
import { plugins, users } from "./schema.js";
import { getSecret, verifyPassword } from "./auth.js";
import type { SessionUser } from "./auth.js";
import { deleteOption, getOption, setOption } from "./options.js";
import { ServiceError } from "./errors.js";
import {
  buildOtpauthUrl,
  generateRecoveryCodes,
  generateSecret,
  normalizeRecoveryCode,
  verifyTotp,
} from "./totp.js";

export const TWOFA_PLUGIN_SLUG = "two-factor";
const ISSUER = "oboext";
const RECOVERY_COUNT = 20;

type RecoveryRecord = { h: string; usedAt: string | null };

export type TwoFaState = {
  v: 1;
  secret: string;

  enabled: boolean;
  recovery: RecoveryRecord[];
  createdAt: string;
};

const storeKey = (userId: number) => `twofa:user:${userId}`;

export async function isTwoFactorPluginEnabled(): Promise<boolean> {
  await ensureMigrations();
  const [row] = await db
    .select({ enabled: plugins.enabled })
    .from(plugins)
    .where(eq(plugins.slug, TWOFA_PLUGIN_SLUG));
  return !!row?.enabled;
}

export async function getTwoFaState(
  userId: number,
): Promise<TwoFaState | null> {
  return (await getOption<TwoFaState | null>(storeKey(userId), null)) ?? null;
}

function hashRecoveryCode(code: string): string {
  return crypto
    .createHmac("sha256", getSecret())
    .update(`twofa-recovery:${normalizeRecoveryCode(code)}`)
    .digest("hex");
}

function timingEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export async function beginEnrollment(user: SessionUser): Promise<{
  secret: string;
  otpauth: string;
}> {
  const secret = generateSecret();
  const state: TwoFaState = {
    v: 1,
    secret,
    enabled: false,
    recovery: [],
    createdAt: new Date().toISOString(),
  };
  await setOption(storeKey(user.id), state);
  const label = user.email || user.name || `user-${user.id}`;
  return { secret, otpauth: buildOtpauthUrl(label, secret, ISSUER) };
}

export async function confirmEnrollment(
  user: SessionUser,
  code: string,
): Promise<string[]> {
  const state = await getTwoFaState(user.id);
  if (!state || state.enabled) {
    throw new ServiceError("请先开始绑定流程", 400);
  }
  if (!verifyTotp(state.secret, code)) {
    throw new ServiceError("动态码不正确，请确认手机时间是否准确", 400);
  }
  const codes = generateRecoveryCodes(RECOVERY_COUNT);
  state.enabled = true;
  state.recovery = codes.map((c) => ({ h: hashRecoveryCode(c), usedAt: null }));
  await setOption(storeKey(user.id), state);
  return codes;
}

export type TwoFaStatus = {
  enabled: boolean;

  pending: boolean;
  recoveryRemaining: number;
};

export async function getTwoFaStatus(user: SessionUser): Promise<TwoFaStatus> {
  const state = await getTwoFaState(user.id);
  return {
    enabled: !!state?.enabled,
    pending: !!state && !state.enabled,
    recoveryRemaining:
      state?.recovery.filter((r) => r.usedAt === null).length ?? 0,
  };
}

export async function verifyTwoFaCode(
  userId: number,
  rawCode: string,
): Promise<boolean> {
  const state = await getTwoFaState(userId);
  if (!state?.enabled) return false;
  const code = String(rawCode ?? "").trim();

  if (/^\d{6}$/.test(code)) {
    return verifyTotp(state.secret, code);
  }

  const h = hashRecoveryCode(code);
  const idx = state.recovery.findIndex(
    (r) => r.usedAt === null && timingEqualHex(r.h, h),
  );
  if (idx === -1) return false;
  state.recovery[idx] = { ...state.recovery[idx], usedAt: new Date().toISOString() };
  await setOption(storeKey(userId), state);
  return true;
}

export async function disableTwoFa(
  user: SessionUser,
  password: string,
): Promise<void> {
  await ensureMigrations();
  const [row] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, user.id));
  if (!row || !(await verifyPassword(password, row.passwordHash))) {
    throw new ServiceError("登录密码不正确", 400);
  }
  await deleteOption(storeKey(user.id));
}

export async function regenerateRecoveryCodes(
  user: SessionUser,
  code: string,
): Promise<string[]> {
  const state = await getTwoFaState(user.id);
  if (!state?.enabled) throw new ServiceError("尚未启用两步验证", 400);
  if (!verifyTotp(state.secret, code)) {
    throw new ServiceError("动态码不正确", 400);
  }
  const codes = generateRecoveryCodes(RECOVERY_COUNT);
  state.recovery = codes.map((c) => ({ h: hashRecoveryCode(c), usedAt: null }));
  await setOption(storeKey(user.id), state);
  return codes;
}
