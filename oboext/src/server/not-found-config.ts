// 404 page configuration — ported from Oboext lib/services/not-found-config.ts.
import { eq } from "drizzle-orm";
import { db } from "./db.js";
import { options } from "./schema.js";
import { invalidate, memoStrict } from "./cache.js";

export interface NotFoundSettings {
  title: string;
  message: string;
  showSearch: boolean;
  showRecent: boolean;
}

const OPTION_KEY = "notFoundSettings";

export const DEFAULT_NOT_FOUND: NotFoundSettings = {
  title: "404 - 页面走丢了",
  message: "您访问的页面不存在或已被移动，请检查网址是否正确，或返回首页继续浏览。",
  showSearch: true,
  showRecent: true,
};

export async function getNotFoundSettings(): Promise<NotFoundSettings> {
  // Hard-TTL memo: the 404 page renders on every unknown path, and bots probe constantly — an uncached options read here cost one round trip per miss.
  return memoStrict("nf:settings", 30_000, async () => {
    const [row] = await db
      .select({ value: options.value })
      .from(options)
      .where(eq(options.key, OPTION_KEY));
    const stored = (row?.value as Partial<NotFoundSettings>) ?? {};
    return { ...DEFAULT_NOT_FOUND, ...stored };
  });
}

export async function saveNotFoundSettings(
  input: Partial<NotFoundSettings>,
): Promise<NotFoundSettings> {
  const current = await getNotFoundSettings();
  const next: NotFoundSettings = {
    title:
      typeof input.title === "string" && input.title.trim()
        ? input.title.trim().slice(0, 120)
        : current.title,
    message:
      typeof input.message === "string"
        ? input.message.slice(0, 500)
        : current.message,
    showSearch:
      typeof input.showSearch === "boolean" ? input.showSearch : current.showSearch,
    showRecent:
      typeof input.showRecent === "boolean" ? input.showRecent : current.showRecent,
  };
  await db
    .insert(options)
    .values({ key: OPTION_KEY, value: next })
    .onConflictDoUpdate({ target: options.key, set: { value: next } });
  invalidateNotFoundSettings();
  return next;
}

/** Drop the cached settings after an admin save. */
export function invalidateNotFoundSettings(): void {
  invalidate("nf:settings");
}
