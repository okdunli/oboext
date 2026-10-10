

import { eq } from "drizzle-orm";
import { db } from "./db.js";
import { options } from "./schema.js";
import { ServiceError } from "./admin.js";
import type { Role } from "./auth.js";

export const ADMIN_HOME_DEFAULT = "/admin";
const OPTION_HIDDEN = "adminMenuHidden";
const OPTION_HOME = "adminHomePath";

export type MenuLeaf = {
  href: string;
  label: string;
  /** sidebar glyph used by our AdminShell port (the original used lucide icons) */
  glyph?: string;
  exact?: boolean;
  external?: boolean;
  adminOnly?: boolean;
  superOnly?: boolean;
  /** plugin/theme hook entries: can be toggled but never chosen as home */
  hook?: boolean;
  /** system locked: always visible, can neither hide nor become home */
  locked?: boolean;
};

export type MenuGroup = {
  id: string;
  label: string;
  glyph?: string;
  adminOnly?: boolean;
  superOnly?: boolean;
  children: MenuLeaf[];
};

/** The dashboard is a standalone top-level entry; participates in prefs as a virtual leaf. */
export const DASHBOARD_LEAF: MenuLeaf = {
  href: ADMIN_HOME_DEFAULT,
  label: "仪表盘",
  glyph: "▦",
  exact: true,
};

const CORE_GROUPS: MenuGroup[] = [
  {
    id: "content",
    label: "内容管理",
    glyph: "✎",
    children: [
      { href: "/admin/posts", label: "文章", glyph: "✎" },
      { href: "/admin/pages", label: "页面", glyph: "📄" },
      { href: "/admin/categories", label: "分类", glyph: "▤" },
      { href: "/admin/tags", label: "标签", glyph: "#" },
      { href: "/admin/comments", label: "评论", glyph: "💬", adminOnly: true },
      { href: "/admin/media", label: "媒体库", glyph: "🖼" },
    ],
  },
  {
    id: "appearance",
    label: "外观设置",
    glyph: "🎨",
    children: [
      { href: "/admin/themes", label: "主题", glyph: "🎨", superOnly: true },
      { href: "/admin/widgets", label: "小工具", glyph: "🧩", superOnly: true },
      { href: "/admin/menus", label: "菜单", glyph: "🧭", superOnly: true },
    ],
  },
  {
    id: "system",
    label: "系统设置",
    glyph: "⚙",
    superOnly: true,
    children: [
      { href: "/admin/settings", label: "站点设置", glyph: "⚙" },
      { href: "/admin/menu-settings", label: "菜单与首页", glyph: "▣", locked: true },
      { href: "/admin/users", label: "用户", glyph: "👤" },
    ],
  },
];

function roleAllows(role: Role, x: { adminOnly?: boolean; superOnly?: boolean }): boolean {
  if (x.superOnly) return role === "admin";
  if (x.adminOnly) return role === "admin" || role === "editor";
  return true;
}

export function buildAdminMenuAll(): MenuGroup[] {
  return [
    { id: "top", label: "顶部入口", glyph: "▦", children: [DASHBOARD_LEAF] },
    ...CORE_GROUPS,
  ];
}

/** Sidebar view: role + hiddenHrefs filtering, empty groups dropped. */
export function filterGroupsForShell(
  role: Role,
  hiddenHrefs: string[],
): MenuGroup[] {
  const hidden = new Set(hiddenHrefs);
  const out: MenuGroup[] = [];
  for (const g of CORE_GROUPS) {
    if (!roleAllows(role, g)) continue;
    const children = g.children.filter(
      (l) => roleAllows(role, l) && !hidden.has(l.href),
    );
    if (children.length) out.push({ ...g, children });
  }
  return out;
}

export type MenuPrefs = { hiddenHrefs: string[]; homePath: string };

export async function getAdminMenuPrefs(): Promise<MenuPrefs> {
  const read = async (key: string): Promise<unknown> => {
    try {
      const rows = await db
        .select({ value: options.value })
        .from(options)
        .where(eq(options.key, key))
        .limit(1);
      return rows[0]?.value;
    } catch {
      return undefined;
    }
  };
  const [hidden, home] = await Promise.all([
    read(OPTION_HIDDEN),
    read(OPTION_HOME),
  ]);
  return {
    hiddenHrefs: Array.isArray(hidden)
      ? hidden.filter((x): x is string => typeof x === "string")
      : [],
    homePath:
      typeof home === "string" && home.startsWith("/admin")
        ? home
        : ADMIN_HOME_DEFAULT,
  };
}

export async function saveAdminMenuPrefs(input: {
  hiddenHrefs: unknown;
  homePath: unknown;
}): Promise<MenuPrefs> {
  const leaves = [
    DASHBOARD_LEAF,
    ...buildAdminMenuAll().flatMap((g) => g.children),
  ];
  const byHref = new Map(leaves.map((l) => [l.href, l]));

  const home =
    typeof input.homePath === "string" ? input.homePath : ADMIN_HOME_DEFAULT;
  if (home !== ADMIN_HOME_DEFAULT) {
    const leaf = byHref.get(home);
    if (!leaf || leaf.hook || leaf.external || leaf.locked) {
      throw new ServiceError("首页只能设为系统内置页面", 400);
    }
  }

  const rawHidden = Array.isArray(input.hiddenHrefs) ? input.hiddenHrefs : [];
  const hiddenHrefs = [
    ...new Set(
      rawHidden.filter(
        (x): x is string =>
          typeof x === "string" &&
          byHref.has(x) &&
          x !== home &&
          !byHref.get(x)?.locked,
      ),
    ),
  ];

  await Promise.all([
    upsertOption(OPTION_HIDDEN, hiddenHrefs),
    upsertOption(OPTION_HOME, home),
  ]);
  return { hiddenHrefs, homePath: home };
}

async function upsertOption(key: string, value: unknown): Promise<void> {
  await db
    .insert(options)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: options.key,
      set: { value, updatedAt: new Date() },
    });
}

export type NavItem =
  | { kind: "gstart"; label: string }
  | { kind: "link"; href: string; label: string; glyph: string; active: boolean }
  | { kind: "gend" };

/**
 * Flattened stream the admin layout renders with a single {#each} (nested
 * directives are unsupported by the .rose compiler). Dashboard visibility and
 * the /admin vs /admin/dashboard href swap mirror AdminShell.tsx.
 */
export function shellNav(
  role: Role,
  pathname: string,
  prefs: MenuPrefs,
): NavItem[] {
  const hidden = new Set(prefs.hiddenHrefs);
  const out: NavItem[] = [];
  const isActive = (l: MenuLeaf) =>
    l.exact
      ? pathname === l.href
      : pathname === l.href || pathname.startsWith(l.href + "/");

  if (!hidden.has(ADMIN_HOME_DEFAULT)) {
    const href =
      prefs.homePath === ADMIN_HOME_DEFAULT ? ADMIN_HOME_DEFAULT : "/admin/dashboard";
    out.push({ kind: "gstart", label: "概览" });
    out.push({
      kind: "link",
      href,
      label: DASHBOARD_LEAF.label,
      glyph: DASHBOARD_LEAF.glyph || "▦",
      active: pathname === href,
    });
    out.push({ kind: "gend" });
  }

  for (const g of filterGroupsForShell(role, prefs.hiddenHrefs)) {
    out.push({ kind: "gstart", label: g.label });
    for (const l of g.children) {
      out.push({
        kind: "link",
        href: l.href,
        label: l.label,
        glyph: l.glyph || "",
        active: isActive(l),
      });
    }
    out.push({ kind: "gend" });
  }
  return out;
}

/**
 * /admin and /admin/dashboard swap targets depending on the home preference
 * (mirrors app/admin/page.tsx + app/admin/dashboard/page.tsx). Returns the
 * redirect target when one applies, otherwise null.
 */
export function homeRedirectFor(pathname: string, prefs: MenuPrefs): string | null {
  if (pathname === "/admin" && prefs.homePath !== ADMIN_HOME_DEFAULT) {
    return prefs.homePath;
  }
  if (pathname === "/admin/dashboard" && prefs.homePath === ADMIN_HOME_DEFAULT) {
    return ADMIN_HOME_DEFAULT;
  }
  return null;
}

const escText = (s: string): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string): string => escText(s).replace(/"/g, "&quot;");

/**
 * Pre-rendered sidebar nav. The .rose compiler cannot nest directives
 * (if > each > if), so the preference-driven nav ships as one raw HTML blob
 * through the session loader, exactly like the public chrome nav/aside/footer.
 */
export function shellNavHtml(
  role: Role,
  pathname: string,
  prefs: MenuPrefs,
): string {
  const items = shellNav(role, pathname, prefs);
  let html = "";
  for (const n of items) {
    if (n.kind === "gstart") {
      html +=
        '<div class="adm-nav-group"><div class="adm-nav-title">' +
        escText(n.label) +
        "</div>";
    } else if (n.kind === "link") {
      html +=
        '<a' +
        (n.active ? ' class="is-active"' : "") +
        ' href="' +
        escAttr(n.href) +
        '"><span class="ic">' +
        escText(n.glyph) +
        "</span> " +
        escText(n.label) +
        "</a>";
    } else {
      html += "</div>";
    }
  }
  return html;
}
