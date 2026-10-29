import { eq } from "drizzle-orm";
import { db } from "./db.js";
import { users } from "./schema.js";

// The passwordless flag lives on the users row (see migration 0024), so marking
// or clearing is an atomic single-row UPDATE - no shared option array to
// read-modify-write and lose ids under concurrency (which locked users out).
// Reads go straight to the row; a single indexed primary-key lookup.

export async function isPasswordlessUser(userId: number): Promise<boolean> {
  const [row] = await db
    .select({ passwordless: users.passwordless })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return !!row?.passwordless;
}

export async function addPasswordlessMark(userId: number): Promise<void> {
  await db.update(users).set({ passwordless: true }).where(eq(users.id, userId));
}

export async function clearPasswordlessMark(userId: number): Promise<void> {
  await db.update(users).set({ passwordless: false }).where(eq(users.id, userId));
}
