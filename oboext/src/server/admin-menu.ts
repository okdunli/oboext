// Admin sidebar menu model + per-admin navigation preferences.
import { getOption, setOption } from "./options.js";
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
  label: "@admin.nav.dash",
  glyph: "layout-dashboard",
  exact: true,
};

// Keep labels/flags/order in sync with lib/admin-menu.ts; leaves for not-yet-
// ported screens (icons, themes, permalinks, ...) join when their pages land.
const CORE_GROUPS: MenuGroup[] = [
  {
    id: "content",
    label: "@admin.nav.content",
    glyph: "file-text",
    children: [
      { href: "/admin/posts", label: "@admin.nav.posts", glyph: "file-text" },
      { href: "/admin/pages", label: "@admin.nav.pages", glyph: "files" },
      { href: "/admin/categories", label: "@admin.nav.categories", glyph: "folder" },
      { href: "/admin/tags", label: "@admin.nav.tags", glyph: "tags" },
      { href: "/admin/comments", label: "@admin.nav.comments", glyph: "message-square", adminOnly: true },
      { href: "/admin/webmentions", label: "@admin.nav.webmentions", glyph: "message-square", adminOnly: true },
      { href: "/admin/newsletter", label: "@admin.nav.newsletter", glyph: "mail", adminOnly: true },
      { href: "/admin/search-terms", label: "@admin.nav.search_terms", glyph: "search", adminOnly: true },
      { href: "/admin/media", label: "@admin.nav.media", glyph: "image" },
    ],
  },
  {
    id: "appearance",
    label: "@admin.nav.appearance",
    glyph: "palette",
    children: [
      { href: "/admin/themes", label: "@admin.nav.themes", glyph: "palette", superOnly: true },
      { href: "/admin/widgets", label: "@admin.nav.widgets", glyph: "layout-grid", superOnly: true },
      { href: "/admin/menus", label: "@admin.nav.menus", glyph: "menu", superOnly: true },
    ],
  },
  {
    id: "plugins",
    label: "@admin.nav.plugins",
    glyph: "plug",
    superOnly: true,
    children: [
      { href: "/admin/plugins", label: "@admin.nav.plugins_all", glyph: "plug", exact: true },
    ],
  },
  {
    id: "personal",
    label: "@admin.nav.personal",
    glyph: "user-round",
    children: [
      { href: "/admin/account", label: "@admin.nav.account", glyph: "user-round" },
    ],
  },
  {
    id: "users",
    label: "@admin.nav.users_group",
    glyph: "users",
    superOnly: true,
    children: [
      { href: "/admin/users", label: "@admin.nav.users", glyph: "users" },
      { href: "/admin/members", label: "@admin.nav.members", glyph: "user-plus", superOnly: true },
      { href: "/admin/oauth", label: "@admin.nav.oauth", glyph: "share-2", superOnly: true },
    ],
  },
  {
    id: "system",
    label: "@admin.nav.system",
    glyph: "settings",
    superOnly: true,
    children: [
      { href: "/admin/settings", label: "@admin.nav.settings", glyph: "settings" },
      { href: "/admin/security", label: "@admin.nav.security", glyph: "shield", superOnly: true },
      { href: "/admin/security-logs", label: "@admin.nav.security_logs", glyph: "scroll-text", superOnly: true },
      { href: "/admin/maintenance", label: "@admin.nav.maintenance", glyph: "construction", superOnly: true },
      { href: "/admin/email", label: "@admin.nav.email", glyph: "mail", superOnly: true },
      { href: "/admin/sms", label: "@admin.nav.sms", glyph: "smartphone", superOnly: true },
    ],
  },
  {
    id: "tools",
    label: "@admin.nav.tools",
    glyph: "wrench",
    superOnly: true,
    children: [
      { href: "/admin/permalinks", label: "@admin.nav.permalinks", glyph: "link-2", superOnly: true },
      { href: "/admin/redirects", label: "@admin.nav.redirects", glyph: "arrow-right-left", superOnly: true },
      { href: "/admin/notfound", label: "@admin.nav.notfound", glyph: "file-question" },
      { href: "/admin/backup", label: "@admin.nav.backup", glyph: "database-backup", superOnly: true },
      { href: "/admin/export", label: "@admin.nav.export", glyph: "file-text", superOnly: true },
      { href: "/admin/icons", label: "@admin.nav.icons", glyph: "shapes", superOnly: true },
      { href: "/admin/menu-settings", label: "@admin.nav.menu_settings", glyph: "panel-left", locked: true },
    ],
  },
];

/** Exported R259: the sidebar's adminOnly/superOnly meaning is ALSO the
 *  backend's policy for the screens those entries open. Keeping one copy of
 *  `adminOnly = admin || editor` means a future menu edit and the loader gate
 *  cannot drift apart. */
export function roleAllows(role: Role, x: { adminOnly?: boolean; superOnly?: boolean }): boolean {
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

// The admin shell renders this on EVERY page (admin.session -> navRaw), and
// listPlugins() re-reads the whole plugins table plus a settings resolution per
// row each time. Nothing here varies between requests - it only changes when a
// plugin is toggled, installed, or contributes a different menu - so a short
// TTL memo (the same 5s window the option store and hotCache already use) keeps
// that select off the request path. A toggle/install therefore shows up in the
// sidebar within 5s — the same eventual-consistency bound every other cached
// read here ships with. Wiring an explicit invalidation would close that gap but
// needs an admin-menu -> plugins -> plugin-loader -> admin-menu import cycle.
const EXTRAS_TTL_MS = 5_000;
let extrasMemo: { at: number; value: AdminMenuExtras } | null = null;

// Collect plugin/theme menu contributions (original parity: collectAdminMenuExtras).
export async function collectAdminMenuExtras(): Promise<AdminMenuExtras> {
  if (extrasMemo && Date.now() - extrasMemo.at < EXTRAS_TTL_MS) return extrasMemo.value;
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
  const value: AdminMenuExtras = {
    pluginNav,
    pluginPanels,
    pluginSections: [...sectionMap.values()],
  };
  extrasMemo = { at: Date.now(), value };
  return value;
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
    { id: "top", label: "@admin.nav.top", glyph: "layout-dashboard", children: [DASHBOARD_LEAF] },
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
  // Two rows the admin shell reads on EVERY page render. Going through the
  // option store's TTL memo (5s, same eventual-consistency contract as
  // hotCache and the permalink memo) instead of hand-rolled selects keeps
  // those round trips off the request path.
  const read = async (key: string): Promise<unknown> => {
    try {
      return await getOption<unknown>(key);
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

  // setOption(), not a raw upsert: it refreshes the memo the reads above now
  // serve from, so saving the menu takes effect on this instance immediately
  // (the 5s TTL only bounds the other instances).
  await Promise.all([
    setOption(OPTION_HIDDEN, hiddenHrefs),
    setOption(OPTION_HOME, home),
  ]);
  return { hiddenHrefs, homePath: home };
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
/** Built-in entries carry a catalog marker ("@admin.nav.posts"); hook and
 *  plugin contributions carry the literal label their author wrote. One
 *  resolver, so the sidebar and the menu settings screen can never disagree. */
export function menuLabelText(label: string, t?: (key: string) => string): string {
  return label.startsWith("@") && t ? t(label.slice(1)) : label;
}

export function localizeMenuGroups(groups: MenuGroup[], t?: (key: string) => string): MenuGroup[] {
  return groups.map((g) => ({
    ...g,
    label: menuLabelText(g.label, t),
    children: g.children.map((c) => ({ ...c, label: menuLabelText(c.label, t) })),
  }));
}

export function shellNavHtml(
  role: Role,
  pathname: string,
  prefs: MenuPrefs,
  extras?: AdminMenuExtras,
  t?: (key: string) => string,
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
        escText(menuLabelText(n.label, t)) +
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
        escText(menuLabelText(n.label, t)) +
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
        escText(menuLabelText(n.label, t)) +
        "</span></a>";
    } else {
      html += "</div></div>";
    }
  }
  return html;
}
