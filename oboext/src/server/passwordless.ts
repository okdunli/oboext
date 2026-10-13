

import { getOption, setOption } from "./options.js";

const NOPASSWORD_KEY = "oauth.nopassword";

export async function getPasswordlessSet(): Promise<Set<number>> {
  const arr = await getOption<number[]>(NOPASSWORD_KEY, []);
  return new Set(Array.isArray(arr) ? arr : []);
}

export async function addPasswordlessMark(userId: number): Promise<void> {
  const set = await getPasswordlessSet();
  set.add(userId);
  await setOption(NOPASSWORD_KEY, [...set]);
}

export async function clearPasswordlessMark(userId: number): Promise<void> {
  const set = await getPasswordlessSet();
  if (set.delete(userId)) await setOption(NOPASSWORD_KEY, [...set]);
}

export async function isPasswordlessUser(userId: number): Promise<boolean> {
  return (await getPasswordlessSet()).has(userId);
}
