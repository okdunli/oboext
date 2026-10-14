// Admin sidebar menu model + per-admin navigation preferences.
import { eq } from "drizzle-orm";
import { db } from "./db.js";
import { options } from "./schema.js";
import { ServiceError } from "./admin.js";
import { admIcon } from "./icons.js";
import type { Role } from "./schema.js";
import { applyAsyncFilters, HOOKS, hasHookOwner } from "./hooks.js";
import { ensurePluginsLoaded, listPlugins } from "./plugins.js";

export const ADMIN_HOME_DEFAULT = "/admin";
const OPTION_HIDDEN = "adminMenuHidden";
const OPTION_HOME = "adminHomePath";

export type MenuLeaf = {
  href: string;
  label: string;
  /** lucide kebab icon name, rendered as a CSS-mask SVG in the sidebar */
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
  glyph: "layout-dashboard",
  exact: true,
};

// Keep labels/flags/order in sync with lib/admin-menu.ts; leaves for not-yet-
// ported screens (icons, themes, permalinks, ...) join when their pages land.
const CORE_GROUPS: MenuGroup[] = [
  {
    id: "content",
    label: "内容管理",
    glyph: "file-text",
    children: [
      { href: "/admin/posts", label: "文章", glyph: "file-text" },
      { href: "/admin/pages", label: "页面", glyph: "files" },
      { href: "/admin/categories", label: "分类", glyph: "folder" },
      { href: "/admin/tags", label: "标签", glyph: "tags" },
      { href: "/admin/comments", label: "评论", glyph: "message-square", adminOnly: true },
      { href: "/admin/media", label: "媒体库", glyph: "image" },
    ],
  },
  {
    id: "appearance",
    label: "外观设置",
    glyph: "palette",
    children: [
      { href: "/admin/themes", label: "主题", glyph: "palette", superOnly: true },
      { href: "/admin/widgets", label: "小工具", glyph: "layout-grid", superOnly: true },
      { href: "/admin/menus", label: "菜单", glyph: "menu", superOnly: true },
    ],
  },
  {
    id: "plugins",
    label: "插件扩展",
    glyph: "plug",
    superOnly: true,
    children: [
      { href: "/admin/plugins", label: "全部插件", glyph: "plug", exact: true },
    ],
  },
  {
    id: "personal",
    label: "个人中心",
    glyph: "user-round",
    children: [
      { href: "/admin/account", label: "我的账号", glyph: "user-round" },
    ],
  },
  {
    id: "users",
    label: "用户与权限",
    glyph: "users",
    superOnly: true,
    children: [
      { href: "/admin/users", label: "用户", glyph: "users" },
      { href: "/admin/members", label: "会员注册", glyph: "user-plus", superOnly: true },
      { href: "/admin/oauth", label: "第三方登录", glyph: "share-2", superOnly: true },
    ],
  },
  {
    id: "system",
    label: "系统设置",
    glyph: "settings",
    superOnly: true,
    children: [
      { href: "/admin/settings", label: "站点设置", glyph: "settings" },
      { href: "/admin/security", label: "后台安全", glyph: "shield", superOnly: true },
      { href: "/admin/security-logs", label: "安全日志", glyph: "scroll-text", superOnly: true },
      { href: "/admin/maintenance", label: "维护模式", glyph: "construction", superOnly: true },
      { href: "/admin/email", label: "邮件设置", glyph: "mail", superOnly: true },
      { href: "/admin/sms", label: "短信设置", glyph: "smartphone", superOnly: true },
    ],
  },
  {
    id: "tools",
    label: "站点工具",
    glyph: "wrench",
    superOnly: true,
    children: [
      { href: "/admin/permalinks", label: "固定链接", glyph: "link-2", superOnly: true },
      { href: "/admin/notfound", label: "404 页面", glyph: "file-question" },
      { href: "/admin/backup", label: "备份恢复", glyph: "database-backup", superOnly: true },
      { href: "/admin/export", label: "内容导出", glyph: "file-text", superOnly: true },
      { href: "/admin/icons", label: "图标库", glyph: "shapes", superOnly: true },
      { href: "/admin/menu-settings", label: "菜单与首页", glyph: "panel-left", locked: true },
    ],
  },
];

function roleAllows(role: Role, x: { adminOnly?: boolean; superOnly?: boolean }): boolean {
  if (x.superOnly) return role === "admin";
  if (x.adminOnly) return role === "admin" || role === "editor";
  return true;
}

// ------------------------------------------------- plugin / theme hook menu

// Serializable sidebar entry added via the `admin.menu` hook (port of lib/admin-extensions.ts AdminMenuItem; icons are kebab names rendered as CSS-mask).
export type AdminMenuItem = {
  href: string;
  label: string;
  glyph?: string;
  exact?: boolean;
  external?: boolean;
  adminOnly?: boolean;
  superOnly?: boolean;
};

/** A plugin/theme may promote its entries to a top-level group. */
export type AdminMenuSection = {
  section: string;
  label: string;
  glyph?: string;
  adminOnly?: boolean;
  superOnly?: boolean;
  items: AdminMenuItem[];
};

export type AdminMenuEntry = AdminMenuItem | AdminMenuSection;

// Serializable stat card added to the dashboard via the `dashboard.cards` hook (port of lib/admin-extensions.ts DashboardCardItem).
export type DashboardCardItem = {
  label: string;
  value: string | number;
  sub?: string;
  href?: string;
};

export function isAdminMenuSection(entry: AdminMenuEntry): entry is AdminMenuSection {
  return (
    typeof (entry as AdminMenuSection)?.section === "string" &&
    Array.isArray((entry as AdminMenuSection).items)
  );
}

export type AdminMenuExtras = {

  pluginNav: AdminMenuItem[];
  /** Enabled plugins shipping an admin panel get an automatic entry. */
  pluginPanels: { slug: string; name: string }[];
  /** Hook-claimed top-level groups (same section id merges). */
  pluginSections: AdminMenuSection[];
};

// Collect plugin/theme menu contributions (original parity: collectAdminMenuExtras).
export async function collectAdminMenuExtras(): Promise<AdminMenuExtras> {
  await ensurePluginsLoaded();
  const [{ items }, pluginList] = await Promise.all([
    applyAsyncFilters(HOOKS.adminMenu, { items: [] as AdminMenuEntry[] }),
    listPlugins(),
  ]);
  const pluginPanels = pluginList
    .filter((p) => p.enabled && hasHookOwner(HOOKS.adminPanel, p.slug))
    .map((p) => ({ slug: p.slug, name: p.name }));

  const pluginNav: AdminMenuItem[] = [];
  const sectionMap = new Map<string, AdminMenuSection>();
  for (const entry of items) {
    if (isAdminMenuSection(entry)) {
      const existing = sectionMap.get(entry.section);
      if (existing) existing.items.push(...entry.items);
      else sectionMap.set(entry.section, { ...entry, items: [...entry.items] });
    } else {
      pluginNav.push(entry);
    }
  }
  return { pluginNav, pluginPanels, pluginSections: [...sectionMap.values()] };
}

const EMPTY_EXTRAS: AdminMenuExtras = { pluginNav: [], pluginPanels: [], pluginSections: [] };

const hookLeaf = (item: AdminMenuItem): MenuLeaf => ({
  href: item.href,
  label: item.label,
  ...(item.glyph ? { glyph: item.glyph } : {}),
  ...(item.exact ? { exact: true } : {}),
  external: item.external ?? /^https?:\/\//i.test(item.href),
  ...(item.adminOnly ? { adminOnly: true } : {}),
  ...(item.superOnly ? { superOnly: true } : {}),
  hook: true,
});

// The sidebar's single data source: core groups + plugin panels + hook entries + hook-claimed sections.
export function buildAdminMenuGroups(extras: AdminMenuExtras = EMPTY_EXTRAS): MenuGroup[] {
  const { pluginNav, pluginPanels, pluginSections } = extras;
  const panelHrefs = new Set(pluginPanels.map((p) => `/admin/plugins/${p.slug}`));
  const seen = new Set<string>();
  const dedupe = (item: AdminMenuItem): MenuLeaf | null => {
    if (panelHrefs.has(item.href) || seen.has(item.href)) return null;
    seen.add(item.href);
    return hookLeaf(item);
  };
  const sectionToGroup = (s: AdminMenuSection): MenuGroup => ({
    id: `sec:${s.section}`,
    label: s.label,
    ...(s.glyph ? { glyph: s.glyph } : {}),
    ...(s.adminOnly ? { adminOnly: true } : {}),
    ...(s.superOnly ? { superOnly: true } : {}),
    children: s.items.map(dedupe).filter((l): l is MenuLeaf => l !== null),
  });

  return [
    ...CORE_GROUPS.slice(0, 2),
    {
      ...CORE_GROUPS[2],
      children: [
        ...pluginPanels.map<MenuLeaf>((p) => ({
          href: `/admin/plugins/${p.slug}`,
          label: p.name,
          glyph: "plug",
          hook: true,
        })),
        ...pluginNav.map(dedupe).filter((l): l is MenuLeaf => l !== null),
        ...CORE_GROUPS[2].children,
      ],
    },
    ...pluginSections.map(sectionToGroup),
    ...CORE_GROUPS.slice(3),
  ];
}

export function buildAdminMenuAll(extras?: AdminMenuExtras): MenuGroup[] {
  return [
    { id: "top", label: "顶部入口", glyph: "layout-dashboard", children: [DASHBOARD_LEAF] },
    ...buildAdminMenuGroups(extras),
  ];
}

/** Sidebar view: role + hiddenHrefs filtering, empty groups dropped. */
export function filterGroupsForShell(
  role: Role,
  hiddenHrefs: string[],
  extras?: AdminMenuExtras,
): MenuGroup[] {
  const hidden = new Set(hiddenHrefs);
  const out: MenuGroup[] = [];
  for (const g of buildAdminMenuGroups(extras)) {
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
      return undefined; // fresh/empty options table -> defaults
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

export async function saveAdminMenuPrefs(
  input: {
    hiddenHrefs: unknown;
    homePath: unknown;
  },
  extras?: AdminMenuExtras,
): Promise<MenuPrefs> {
  const leaves = [
    DASHBOARD_LEAF,
    ...buildAdminMenuAll(extras).flatMap((g) => g.children),
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

// ----------------------------------------------------------------- sidebar VM

export type NavItem =
  | { kind: "dash"; href: string; label: string; glyph: string; active: boolean }
  | { kind: "gstart"; id: string; label: string; glyph: string; active: boolean }
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
  extras?: AdminMenuExtras,
): NavItem[] {
  const hidden = new Set(prefs.hiddenHrefs);
  const out: NavItem[] = [];
  const isActive = (l: MenuLeaf) =>
    l.exact
      ? pathname === l.href
      : pathname === l.href || pathname.startsWith(l.href + "/");

  // Dashboard is a standalone top-level entry (AdminShell.tsx), never a group.
  if (!hidden.has(ADMIN_HOME_DEFAULT)) {
    const href =
      prefs.homePath === ADMIN_HOME_DEFAULT ? ADMIN_HOME_DEFAULT : "/admin/dashboard";
    out.push({
      kind: "dash",
      href,
      label: DASHBOARD_LEAF.label,
      glyph: DASHBOARD_LEAF.glyph || "layout-dashboard",
      active: pathname === href,
    });
  }

  for (const g of filterGroupsForShell(role, prefs.hiddenHrefs, extras)) {
    out.push({
      kind: "gstart",
      id: g.id,
      label: g.label,
      glyph: g.glyph || "",
      active: g.children.some(isActive),
    });
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

// ----------------------------------------------------- ready-made nav markup

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
  extras?: AdminMenuExtras,
): string {
  const items = shellNav(role, pathname, prefs, extras);
  const caret =
    '<span class="adm-nav-caret adm-ic adm-ic-sm" style="--i:url(/public/icons/chevron-down.svg)"></span>';
  let html = "";
  for (const n of items) {
    if (n.kind === "dash") {
      html +=
        '<a class="adm-nav-dash' +
        (n.active ? " is-active" : "") +
        '" href="' +
        escAttr(n.href) +
        '">' +
        (n.glyph ? admIcon(n.glyph, 17) : "") +
        "<span>" +
        escText(n.label) +
        "</span></a>";
    } else if (n.kind === "gstart") {
      // Accordion (AdminShell.tsx): the group holding the current route renders
      // expanded by default; admin.js owns click toggling + pjax persistence.
      html +=
        '<div class="adm-nav-group" data-nav-group="' +
        escAttr(n.id) +
        '"><button type="button" class="adm-nav-ghdr' +
        (n.active ? " is-group-active" : "") +
        '" aria-expanded="' +
        (n.active ? "true" : "false") +
        '">' +
        (n.glyph ? admIcon(n.glyph, 15) : "") +
        '<span class="adm-nav-glabel">' +
        escText(n.label) +
        "</span>" +
        caret +
        '</button><div class="adm-nav-leaves"' +
        (n.active ? "" : " hidden") +
        ">";
    } else if (n.kind === "link") {
      html +=
        '<a' +
        (n.active ? ' class="is-active"' : "") +
        ' href="' +
        escAttr(n.href) +
        '">' +
        (n.glyph ? admIcon(n.glyph, 15) : "") +
        "<span>" +
        escText(n.label) +
        "</span></a>";
    } else {
      html += "</div></div>";
    }
  }
  return html;
}
