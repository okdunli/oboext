// Menu service — ported from lib/services/menus.ts.
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "./db.js";
import {
  menus,
  menuItems,
  posts,
  pages,
  categories,
  tags,
  type MenuItem,
} from "./schema.js";
import type { SessionUser } from "./auth.js";
import { invalidatePrefix, memoQuery, SIDEBAR_TTL } from "./cache.js";
import { zhCatalog, type Translate } from "./i18n.js";
import { requireUser, requireCap, ServiceError } from "./admin.js";
import {
  getPermalinkConfig,
  postUrlFor,
  pageUrlFor,
  categoryUrlFor,
  tagUrlFor,
  type PermalinkConfig,
} from "./links.js";

export type MenuNode = {
  id: number;
  label: string;
  url: string;
  type: string;
  target: string;
  icon: string | null;
  referenceSlug: string | null;
  children: MenuNode[];
};

export type MenuWithItems = {
  id: number;
  location: string;
  name: string;
  items: MenuNode[];
};

export type MenuItemInput = {
  id?: number;
  parentId?: number | null;
  order?: number;
  type?: string;
  label: string;
  url: string;
  referenceSlug?: string | null;
  target?: string;
  icon?: string | null;
};

type LegacyKind = "category" | "tag" | "page";

// The unprefixed head a base may have been written as before ("blog/category" → "category").
function legacyHead(base: string): string {
  const segs = base.split("/").filter(Boolean);
  return segs.length > 1 ? segs[segs.length - 1] : "";
}

// Menu rows carried over from an older install keep a URL snapshot taken before the base changed.
function legacyLinkTarget(
  url: string,
  cfg: PermalinkConfig,
): { type: LegacyKind; slug: string } | null {
  const segs = String(url || "")
    .split(/[?#]/)[0]
    .split("/")
    .filter(Boolean);
  if (segs.length !== 2) return null;
  const routes: Array<[LegacyKind, string]> = [
    ["category", cfg.categoryBase],
    ["tag", cfg.tagBase],
    ["page", cfg.pageBase],
  ];
  for (const [type, base] of routes) {
    const head = legacyHead(base);
    if (head && head === segs[0]) return { type, slug: segs[1] };
  }
  return null;
}

async function resolveMenuUrls(
  flat: MenuItem[],
  includeUnpublished: boolean,
): Promise<MenuItem[]> {
  const cfg = await getPermalinkConfig();
  const groups: Record<string, string[]> = {};
  const legacy = new Map<number, { type: LegacyKind; slug: string }>();

  for (const it of flat) {
    if (
      it.referenceSlug &&
      (it.type === "post" || it.type === "page" || it.type === "category" || it.type === "tag")
    ) {
      (groups[it.type] ??= []).push(it.referenceSlug);
      continue;
    }
    if (it.type === "custom" && !it.referenceSlug) {
      const t = legacyLinkTarget(it.url, cfg);
      if (t) {
        (groups[t.type] ??= []).push(t.slug);
        legacy.set(it.id, t);
      }
    }
  }
  if (!Object.keys(groups).length) return flat;

  const resolved = new Map<string, string>();
  const keyOf = (type: string, slug: string) => `${type}:${slug}`;

  if (groups.post) {
    const rows = await db
      .select({
        id: posts.id,
        slug: posts.slug,
        pinyinSlug: posts.pinyinSlug,
        initialSlug: posts.initialSlug,
        title: posts.title,
        publishedAt: posts.publishedAt,
        createdAt: posts.createdAt,
        status: posts.status,
      })
      .from(posts)
      .where(inArray(posts.slug, groups.post));
    for (const r of rows) {
      if (!includeUnpublished && r.status !== "published") continue;
      resolved.set(keyOf("post", r.slug), postUrlFor(cfg, r));
    }
  }
  if (groups.page) {
    const rows = await db
      .select({ slug: pages.slug, status: pages.status })
      .from(pages)
      .where(inArray(pages.slug, groups.page));
    for (const r of rows) {
      if (!includeUnpublished && r.status !== "published") continue;
      resolved.set(keyOf("page", r.slug), pageUrlFor(cfg, r));
    }
  }
  if (groups.category) {
    const rows = await db
      .select({ slug: categories.slug })
      .from(categories)
      .where(inArray(categories.slug, groups.category));
    for (const r of rows) resolved.set(keyOf("category", r.slug), categoryUrlFor(cfg, r));
  }
  if (groups.tag) {
    const rows = await db
      .select({ slug: tags.slug })
      .from(tags)
      .where(inArray(tags.slug, groups.tag));
    for (const r of rows) resolved.set(keyOf("tag", r.slug), tagUrlFor(cfg, r));
  }

  return flat.map((it) => {
    if (it.referenceSlug) {
      const url = resolved.get(keyOf(it.type, it.referenceSlug));
      return url ? { ...it, url } : it;
    }
    const t = legacy.get(it.id);
    if (!t) return it;
    const url = resolved.get(keyOf(t.type, t.slug));
    return url && url !== it.url ? { ...it, url } : it;
  });
}

function buildTree(flat: MenuItem[]): MenuNode[] {
  const byId = new Map<number, MenuNode>();
  flat.forEach((it) =>
    byId.set(it.id, {
      id: it.id,
      label: it.label,
      url: it.url,
      type: it.type,
      target: it.target,
      icon: it.icon,
      referenceSlug: it.referenceSlug,
      children: [],
    }),
  );
  const roots: MenuNode[] = [];
  flat.forEach((it) => {
    const node = byId.get(it.id)!;
    if (it.parentId && byId.has(it.parentId)) {
      byId.get(it.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  });
  return roots;
}

async function flatItems(menuId: number): Promise<MenuItem[]> {
  return db
    .select()
    .from(menuItems)
    .where(eq(menuItems.menuId, menuId))
    .orderBy(asc(menuItems.order), asc(menuItems.id));
}

/** Public menu by theme location — only published references resolve.
 *
 * Memoized per location (SWR, 30s): the chrome render path reads all three
 * locations on every public request; each miss is a menus SELECT plus a
 * menu_items SELECT. The write functions below drop the `menu:` prefix. */
export async function getMenuByLocation(location: string): Promise<MenuWithItems | null> {
  await ensureDefaultMenus();
  return memoQuery(`menu:loc:${location}`, SIDEBAR_TTL, async () => {
    const [menu] = await db.select().from(menus).where(eq(menus.location, location));
    if (!menu) return null;
    const flat = await flatItems(menu.id);
    return {
      id: menu.id,
      location: menu.location,
      name: menu.name,
      items: buildTree(await resolveMenuUrls(flat, false)),
    };
  });
}

export async function listMenus(): Promise<MenuWithItems[]> {
  await ensureDefaultMenus();
  const all = await db.select().from(menus).orderBy(asc(menus.id));
  // One flatItems round trip per menu used to run serially; they are
  // independent, so fetch them together.
  const flats = await Promise.all(all.map((menu) => flatItems(menu.id)));
  const result: MenuWithItems[] = [];
  for (let i = 0; i < all.length; i++) {
    // admin sees draft/unpublished references resolved too
    result.push({
      id: all[i].id,
      location: all[i].location,
      name: all[i].name,
      items: buildTree(await resolveMenuUrls(flats[i], true)),
    });
  }
  return result;
}

export async function getMenu(id: number): Promise<MenuWithItems> {
  const [menu] = await db.select().from(menus).where(eq(menus.id, id));
  if (!menu) throw new ServiceError("菜单不存在", 404);
  const flat = await flatItems(menu.id);
  return {
    id: menu.id,
    location: menu.location,
    name: menu.name,
    items: buildTree(await resolveMenuUrls(flat, true)),
  };
}

export async function createMenu(
  userIn: SessionUser | null,
  location: string,
  name: string,
): Promise<MenuWithItems> {
  const user = requireUser(userIn);
  requireCap(user, "settings:manage");
  const loc = (location || "").trim().slice(0, 40);
  const nm = (name || "").trim().slice(0, 80);
  if (!loc) throw new ServiceError("菜单位置标识不能为空", 422);
  if (!/^[a-z0-9_-]+$/i.test(loc))
    throw new ServiceError("位置标识只能含字母、数字、下划线或短横线", 422);
  if (!nm) throw new ServiceError("菜单名称不能为空", 422);
  const [existing] = await db.select({ id: menus.id }).from(menus).where(eq(menus.location, loc));
  if (existing) throw new ServiceError("该菜单位置已存在", 422);
  const [row] = await db.insert(menus).values({ location: loc, name: nm }).returning();
  invalidatePrefix("menu:");
  return { id: row.id, location: row.location, name: row.name, items: [] };
}

function cleanItem(it: MenuItemInput, i: number) {
  const label = String(it.label ?? "").trim().slice(0, 80);
  if (!label) throw new ServiceError(`第 ${i + 1} 项缺少显示文字`, 422);
  const type = String(it.type ?? "custom").slice(0, 20);
  return {
    clientId: typeof it.id === "number" ? it.id : undefined,
    parentId:
      typeof it.parentId === "number" && Number.isInteger(it.parentId) ? it.parentId : null,
    order: typeof it.order === "number" ? it.order : i,
    type,
    // A default label typed/saved verbatim keeps its translation marker.
    label: menuLabelStore(label),
    url: String(it.url ?? "").slice(0, 500),
    referenceSlug: it.referenceSlug ? String(it.referenceSlug).slice(0, 200) : null,
    target: String(it.target ?? "_self").slice(0, 20) || "_self",
    icon: it.icon ? String(it.icon).slice(0, 100) : null,
  };
}

export async function updateMenu(
  userIn: SessionUser | null,
  id: number,
  input: { name?: string; items?: MenuItemInput[] },
): Promise<MenuWithItems> {
  const user = requireUser(userIn);
  requireCap(user, "settings:manage");
  const [existing] = await db.select().from(menus).where(eq(menus.id, id));
  if (!existing) throw new ServiceError("菜单不存在", 404);

  if (input.name !== undefined) {
    const nm = String(input.name).trim().slice(0, 80);
    if (!nm) throw new ServiceError("菜单名称不能为空", 422);
    await db.update(menus).set({ name: nm, updatedAt: new Date() }).where(eq(menus.id, id));
  }

  const items = input.items;
  if (items) {
    const cleaned = items.map(cleanItem);
    // Whole-list replace. delete+insert gives every row a new id, so writing
    // old parentIds directly would flatten the tree; the two-phase pass maps
    // client ids (positive = persisted, negative = new this save) to real ids
    // and only then backfills parentId. Self/dangling parents become null.
    await db.transaction(async (tx) => {
      await tx.delete(menuItems).where(eq(menuItems.menuId, id));
      const idMap = new Map<number, number>();
      const realIds: number[] = [];
      const pending: Promise<unknown>[] = [];

      for (const it of cleaned) {
        const row = {
          menuId: id,
          order: it.order,
          type: it.type,
          label: it.label,
          url: it.url,
          referenceSlug: it.referenceSlug,
          target: it.target,
          icon: it.icon,
        };
        const [inserted] =
          it.clientId !== undefined && it.clientId > 0
            ? await tx.insert(menuItems).values({ id: it.clientId, ...row }).returning()
            : await tx.insert(menuItems).values(row).returning();
        if (it.clientId !== undefined) idMap.set(it.clientId, inserted.id);
        realIds.push(inserted.id);
      }

      cleaned.forEach((it, i) => {
        const childId = realIds[i];
        let parentReal: number | null = null;
        if (it.parentId) {
          const mapped = idMap.get(it.parentId);
          if (mapped !== undefined && mapped !== childId) parentReal = mapped;
        }
        if (parentReal !== null) {
          pending.push(
            tx
              .update(menuItems)
              .set({ parentId: parentReal })
              .where(eq(menuItems.id, childId)),
          );
        }
      });
      await Promise.all(pending);
    });
    await db.update(menus).set({ updatedAt: new Date() }).where(eq(menus.id, id));
  }
  invalidatePrefix("menu:");

  return getMenu(id);
}

export async function deleteMenu(
  userIn: SessionUser | null,
  id: number,
): Promise<{ id: number }> {
  const user = requireUser(userIn);
  requireCap(user, "settings:manage");
  const [existing] = await db.select({ id: menus.id }).from(menus).where(eq(menus.id, id));
  if (!existing) throw new ServiceError("菜单不存在", 404);
  await db.delete(menus).where(eq(menus.id, id));
  invalidatePrefix("menu:");
  return { id };
}

/** Idempotent default menus (header/footer), ported from bootstrap.ts. */
// Menu labels are free text (admin intent) and are never rewritten — EXCEPT
// the seeded defaults, which the program itself wrote. Those are stored as an
// "@key" marker (fresh installs) or as the zh-CN value of a known key (older
// installs). A custom label such as "我的首页" never matches and stays literal.
export const MENU_DEFAULT_KEYS = ["crumb.home", "sidebar.all_posts", "sidebar.all_pages", "sky.about"];
const MENU_DEFAULT_BY_ZH = new Map(MENU_DEFAULT_KEYS.map((k) => [zhCatalog[k], k]));

/** The stored marker/legacy-zh label as readable text, for the admin editor. */
export function menuLabelDisplay(label: string): string {
  const key = label.startsWith("@") ? label.slice(1) : MENU_DEFAULT_BY_ZH.get(label) ?? "";
  return key && zhCatalog[key] !== undefined ? zhCatalog[key] : label;
}

/** Re-encode a default label back to its "@key" marker on save, so it keeps translating. */
export function menuLabelStore(label: string): string {
  const key = MENU_DEFAULT_BY_ZH.get(label);
  return key ? `@${key}` : label;
}

/** Translate seeded-default labels for the request locale (nested menus too). */
export function localizeMenu<T extends { label?: string; children?: unknown }>(items: T[], t: Translate): T[] {
  return items.map((it) => {
    const raw = String(it.label ?? "");
    const key = raw.startsWith("@") ? raw.slice(1) : MENU_DEFAULT_BY_ZH.get(raw);
    const label = key && zhCatalog[key] !== undefined ? t(key) : it.label;
    return {
      ...it,
      ...(label !== it.label ? { label } : {}),
      ...(Array.isArray(it.children) && it.children.length
        ? { children: localizeMenu(it.children as { label?: string; children?: unknown }[], t) }
        : {}),
    };
  }) as T[];
}

async function seedDefaultMenus(): Promise<void> {
  const defaults = [
    // "@crumb.home" is a translation marker, not a literal: chrome() resolves
    // it per request locale (loaders.ts localizeMenu), so a default menu says
    // "首页" on / and "Home" on /en. Admin-typed labels stay literal.
    { location: "header", name: "顶部导航", item: { label: "@crumb.home", url: "/", order: 1, icon: "house" } },
    { location: "footer", name: "底部导航", item: { label: "@crumb.home", url: "/", order: 1, icon: null } },
  ];
  for (const m of defaults) {
    const [row] = await db
      .insert(menus)
      .values({ location: m.location, name: m.name })
      .onConflictDoNothing({ target: menus.location })
      .returning();
    if (row) {
      await db.insert(menuItems).values({
        menuId: row.id,
        label: m.item.label,
        url: m.item.url,
        order: m.item.order,
        icon: m.item.icon,
      });
    }
  }
}

// Process-level memo, mirroring ensureBootstrap in bootstrap.ts: concurrent
// first callers share one promise; a failure clears it so the next read
// retries. onConflictDoNothing makes the SQL itself idempotent.
let seeded = false;
let seedPromise: Promise<void> | null = null;
export function ensureDefaultMenus(): Promise<void> {
  if (seeded) return Promise.resolve();
  if (!seedPromise) {
    seedPromise = seedDefaultMenus()
      .then(() => {
        seeded = true;
        seedPromise = null;
      })
      .catch((e) => {
        seedPromise = null;
        throw e;
      });
  }
  return seedPromise;
}
