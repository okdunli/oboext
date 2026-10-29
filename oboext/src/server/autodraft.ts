// Auto-draft: per-user, per-page draft autosave stored in the options table
// (overwrite style — no cleanup needed when the edited article is deleted).
import { getOption, setOption } from "./options.js";
import { ServiceError } from "./errors.js";

export const AUTODRAFT_MAX_BYTES = 200 * 1024;

export function autodraftKey(userId: number | string, key: string): string {
  return `autodraft:${userId}:${key}`;
}

export async function saveAutoDraft(
  user: { id: number | string },
  key: string,
  payload: { title?: string; content?: string },
): Promise<void> {
  const body = {
    title: String(payload?.title ?? ""),
    content: String(payload?.content ?? ""),
    updatedAt: new Date().toISOString(),
  };
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > AUTODRAFT_MAX_BYTES) {
    throw new ServiceError("草稿超出大小限制", 413);
  }
  await setOption(autodraftKey(user.id, key), body);
}

export async function getAutoDraft<T = unknown>(
  user: { id: number | string },
  key: string,
): Promise<T | null> {
  return getOption<T | null>(autodraftKey(user.id, key), null);
}
