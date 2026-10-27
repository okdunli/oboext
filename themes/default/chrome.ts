// default theme chrome — this theme's own renderer.
// Self-contained: it imports the program's theme API and nothing else.
import path from "path";
import {
  DEFAULT_LOCALE,
  R,
  catIconName,
  dfIconAccent,
  dfSearchIcon,
  esc,
  fmtDate,
  lucideSvg,
  makeT,
  themeCssContent,
  themeCssHref,
  tr,
} from "../../oboext/src/server/theme-api.js";
import type {
  HomeParts,
  ListParts,
  MenuItem,
  PagePageParts,
  PostPageParts,
  PostView,
  TaxRef,
  ThemeChrome,
  Translate,
} from "../../oboext/src/server/theme-api.js";

// ================================================================ DEFAULT
//
// Faithful port of themes/default (Layout.tsx + HomePage.tsx + PostCard + Sidebar
// + PostPage). We keep the exact utility classes the original emits and
// implement them in themes/default/default.css (token-driven), so the two
// stacks share one visual contract. rosezm builders receive no category/tag
// sidebar rows on list/post pages, so content flows single-column while the
// header/hero/card/footer — the visible "face" — match the original exactly.
// Anti-FOUC base tint only — mirrors the theme stylesheet's own `body` rule
// (pre-CSS-frame flash guard); no `!important`, no forced override on <html>.
const defaultBodyFix = `<style id="rv-body-fix">body{background:var(--bg,#09090b);color:var(--text,#f4f4f5)}</style>`;
// ---------------------------------------------------------------------------
// Fallback icons for categories and nav items.
//
// Categories/menus ship from the database with `icon: null` unless an editor
// set one in admin, which left the front end with bare text (the "no icons"
// symptom). When an item has no icon of its own we fall back to a slug-derived
// glyph so the UI looks complete out of the box; an explicitly set icon always
// wins. Every name here is verified present in public/icons/*.svg.
// ---------------------------------------------------------------------------
const MENU_ICON_MAP: Record<string, string> = {
  "/": "house",
  "/links": "network",
  "/maxim": "quote",
  "/board": "message-square",
};
function menuIconName(it: MenuItem): string {
  const set = it.icon && String(it.icon).trim();
  if (set) return set;
  if (it.url && MENU_ICON_MAP[it.url]) return MENU_ICON_MAP[it.url];
  if (it.label && MENU_ICON_MAP[it.label]) return MENU_ICON_MAP[it.label];
  return "";
}
/**
 * One search field: a real GET form plus the combobox wiring that
 * pjax.js drives.
 *
 * `panelId` MUST be unique per rendered field. The suggestion panel is looked
 * up by id (`aria-controls` -> getElementById) and two fields sharing one id
 * means both write into the same element, so whichever input the visitor types
 * into repaints the other one's list. The three call sites are the header
 * field, the sidebar field and the mobile menu field - all on the same page.
 *
 * The panel is a SIBLING of the box, not a child: the box is a flex row
 * (glyph + input + kbd), so a child panel becomes a third flex item and sits
 * BESIDE the field instead of under it.
 */
function searchField(
  panelId: string,
  placeholder: string,
  label: string,
  formClass: string,
): string {
  return (
    `<form action="/search" method="get" class="${formClass}" role="search">` +
    `<span class="df-search-box">` +
    lucideSvg("search", 16, dfSearchIcon()) +
    `<input name="q" placeholder="${esc(placeholder)}" class="df-search-input" autocomplete="off"` +
    // role=combobox + aria-* is what turns the field into a combobox for a
    // screen reader; without it the suggestion list appears with no announced
    // relationship to the input. aria-expanded is flipped by pjax.js.
    ` role="combobox" aria-expanded="false" aria-autocomplete="list"` +
    ` aria-controls="${panelId}" aria-label="${esc(label)}">` +
    `<kbd class="df-search-kbd">/</kbd>` +
    `<div class="df-suggest" id="${panelId}" hidden></div>` +
    `</span></form>`
  );
}
/** The search field inside the mobile menu drawer. */
function mobileSearchField(t: Translate): string {
  return searchField(
    "df-suggest-mobile",
    t("search.placeholder"),
    t("search.aria"),
    "df-search-form df-search-form-mobile",
  );
}
/**
 * Render a menu list.
 *
 * `highlight` decides whether the "current page" marker is applied at all, and
 * it defaults to TRUE only for the header nav. The footer menu passes false:
 * the footer is site information, not a position indicator, and it was
 * lighting up "Home" on every page of the site. That happened because `path`
 * defaults to "" and norm() maps "" to "/", so the home item - whose rule is
 * `cur === "/" -> href === "/"` - always matched. Passing an empty path is
 * therefore NOT the same as passing no path, which is the whole trap.
 */
function defaultMenuUl(
  items: MenuItem[],
  cls: string,
  path = "",
  highlight = true,
): string {
  if (!items.length) return "";
  // The menu item's own icon leads the label. It was dropped here, so an icon
  // saved in admin/menus never reached the front end at all.
  const link = (it: MenuItem, extra: string) => {
    const mic = menuIconName(it);
    const ic = mic
      ? `<span class="df-menu-ic">${lucideSvg(mic, 14)}</span>`
      : "";
    // "Where am I" is decided HERE, on the server, from the real pathname -
    // not in the browser from a scroll observer. The header is re-rendered on
    // every navigation but the page body is swapped by pjax, so a client-side
    // highlight would always be one navigation behind, and it would need the
    // section list to exist before it could run at all.
    //
    // Trailing slashes are normalised on both sides: "/category/x/" and
    // "/category/x" are the same page to a reader, and treating them as
    // different leaves the highlight off on one of them.
    const norm = (s: string) => s.split("?")[0].split("#")[0].replace(/\/+$/, "") || "/";
    const cur = norm(path);
    const href = norm(it.url || "");
    // Two forms, and the exact match has to be listed separately: the prefix
    // test alone ("does the current path start with href + /") is false for a
    // path that EQUALS href, so "/links" would never light up its own item.
    // That is not a corner case - it is the common case, every top-level page.
    // "/" is excluded from the prefix branch on purpose, or it would match
    // every path on the site and light up "Home" everywhere.
    const isCurrent =
      highlight &&
      (cur === "/"
        ? href === "/"
        : href !== "/" && (cur === href || cur.indexOf(href + "/") === 0));
    return `<a href="${esc(it.url)}"${it.target && it.target !== "_self" ? ` target="${esc(it.target)}" rel="noopener"` : ""} class="df-menu-link${isCurrent ? " is-current" : ""} ${extra}"${isCurrent ? ' aria-current="page"' : ""}>${ic}<span>${esc(it.label)}</span></a>`;
  };
  const lis = items
    .map((it) => {
      const kids = it.children?.length
        ? `<ul class="df-menu-sub">` +
          (it.children || [])
            .map((c) => `<li>${link(c, "hover:text-white")}</li>`)
            .join("") +
          `</ul>`
        : "";
      return `<li class="group relative">${link(it, "hover:text-white")}${kids}</li>`;
    })
    .join("");
  return `<ul class="${cls}">${lis}</ul>`;
}
function defaultNav(settings: Record<string, any>, items: MenuItem[]): string {
  const title = esc(settings.siteTitle ?? "");
  const T: Translate = (k, v) => tr(settings, k, v);
  const headingClass = "text-zinc-100";
  const brandLink =
    settings.logoUrl
      ? `<img src="${esc(settings.logoUrl)}" alt="${title}" class="h-7 w-auto">`
      : `<span class="flex h-8 w-8 items-center justify-center rounded-lg" style="background:var(--accent);color:var(--accent-text)">${(title || "").charAt(0).toUpperCase()}</span>${title}`;
  // No "" fallback here. norm("") maps to "/", so an absent __pathname made
  // the home item match on EVERY page - the highlight said "you are here" for
  // a position the server never actually knew. A missing path now highlights
  // nothing, which is the honest answer; the header still renders.
  const here = settings.__pathname == null ? "" : String(settings.__pathname);
  const menu = defaultMenuUl(items, "df-menu-list", here);
  const hasMenu = items.length > 0;
  // Mobile menu: the desktop nav is hidden below md, so narrow viewports had
  // no way to reach the menu at all. A <details> disclosure needs no script
  // (the theme ships no nav JS) and keeps the same markup for both layouts.
  //
  // It carries the search field too, not just the links. Without it a phone
  // visitor had to leave the menu to search at all: the header search box is
  // inside `hidden ... md:block`, so it does not exist below md, and the
  // sidebar one is further down the page. The field is a second copy with its
  // own suggestion panel id - the header one drives df-suggest-header and
  // two elements must never share a panel.
  const mobileMenu = hasMenu
    ? `<details class="dfm-menu md:hidden">` +
      `<summary class="dfm-burger" aria-label="${T("nav.menu_open")}">${lucideSvg("menu", 20)}</summary>` +
      `<div class="dfm-panel">` +
      mobileSearchField(T) +
      defaultMenuUl(items, "dfm-list", here) +
      `</div>` +
      `</details>`
    : "";
  return `<div class="theme-root relative flex min-h-screen flex-col">` +
    `<header class="sticky top-0 z-30 border-b border-[var(--border)] bg-[var(--bg)]">` +
    `<div class="relative mx-auto flex max-w-5xl items-center gap-4 px-4 py-3">` +
    `<a href="/" class="flex items-center gap-2 text-lg font-bold tracking-tight ${headingClass}">${brandLink}</a>` +
    `<nav class="ml-2 hidden flex-1 md:block">${menu}</nav>` +
    // The search form carries ml-auto so it stays right-aligned; on narrow
    // viewports the burger follows it and takes the trailing slot.
    // The glyph is a flex item inside a bordered pill rather than an
    // absolutely-positioned overlay: absolute positioning depended on a
    // `relative` wrapper plus a pl-9 pad, and any ancestor that failed to
    // establish the containing block let the icon escape the field.
    // The <kbd> advertises the "/" shortcut that theme-default.js binds, so the
    // affordance is visible before the visitor presses anything.
    searchField("df-suggest-header", T("search.placeholder_short"), T("search.aria"), "df-search-form") +
    mobileMenu +
    `</div></header>`;
}
function defaultFooter(settings: Record<string, any>, widgetsHtml: string): string {
  const year = new Date().getFullYear();
  const copy = esc(settings.footerText || `© ${year} ${settings.siteTitle}`);
  const menu = defaultMenuUl(
    (settings.footerMenu as MenuItem[]) || [],
    "df-menu-list df-menu-list-foot",
    "",
    false,
  );
  return `<footer class="relative border-t border-[var(--border)] bg-[var(--footer-bg)] px-4 py-8">` +
    `<div class="mx-auto max-w-5xl">` +
    (widgetsHtml ? `<div class="mb-6">${widgetsHtml}</div>` : "") +
    (menu ? `<nav class="mb-4">${menu}</nav>` : "") +
    // --muted (zinc-400), not text-zinc-500. Lighthouse flagged this line:
    // zinc-500 on the footer background is the only contrast failure left on
    // the page, and it held accessibility at 96/100. Every other muted-text
    // position in this theme already uses the variable, so this was the odd one
    // out rather than a considered choice.
    `<p class="text-xs text-[var(--muted)]">${copy}</p>` +
    `</div></footer>`;
}
function defaultCatPill(c: { name: string; url?: string; icon?: string | null }): string {
  const label = esc(c.name);
  const cls = "df-cat-pill";
  // The category's own icon leads the pill. It was dropped here before, so a
  // category that had an icon set still rendered as bare text on the cards.
  const ic = `<span class="df-cat-pill-ic">${lucideSvg(catIconName(c), 12)}</span>`;
  return c.url
    ? `<a href="${esc(c.url)}" class="${cls}">${ic}${label}</a>`
    : `<span class="${cls}">${ic}${label}</span>`;
}
function defaultPostCard(p: PostView, idx: number, t?: Translate): string {
  const cats = ((p.categories || []).slice(0, 2).map(defaultCatPill)).join("");
  const author = esc(p.author?.name ?? (t ?? makeT(DEFAULT_LOCALE))("post.author_unknown"));
  const comments =
    p.commentsCount > 0
      ? `<span class="df-meta-item">${lucideSvg("message-circle", 13)}${(t ?? makeT(DEFAULT_LOCALE))("post.comments", { n: p.commentsCount })}</span>`
      : "";
  return `<article class="group flex flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] transition hover:-translate-y-0.5 hover:border-[var(--accent)]">` +
    (p.featuredImage
      ? `<a href="${esc(p.url)}" class="block aspect-[16/9] overflow-hidden"><img src="${esc(p.featuredImage)}" alt="${esc(p.title)}" class="h-full w-full object-cover transition duration-300 group-hover:scale-105"${R.imgPerfAttrs(p.featuredImage, { lazy: true, srcset: true })}></a>`
      : "") +
    `<div class="flex flex-1 flex-col p-5">` +
    (cats ? `<div class="mb-2 flex flex-wrap gap-2 text-xs">${cats}</div>` : "") +
    `<h2 class="text-lg font-semibold leading-snug text-[var(--text)]"><a href="${esc(p.url)}" class="transition group-hover:text-[var(--accent)]">${esc(p.title)}</a></h2>` +
    (p.excerpt ? `<p class="mt-2 line-clamp-3 flex-1 text-sm text-[var(--muted)]">${esc(p.excerpt)}</p>` : "") +
    `<div class="mt-4 flex flex-wrap items-center gap-3 text-xs text-[var(--muted)]">` +
    `<span class="df-meta-item">${lucideSvg("user", 13)}${author}</span>` +
    `<span class="df-meta-item">${lucideSvg("calendar", 13)}${fmtDate(p.publishedAt)}</span>` +
    comments +
    `</div></div></article>`;
}
function defaultHome(parts: HomeParts): string {
  const siteTitle = esc((parts.settings.siteTitle as string) ?? "");
  const tagline = parts.settings.tagline ? `<p class="mt-3 text-base text-[var(--muted)]">${esc(parts.settings.tagline as string)}</p>` : "";
  const desc = parts.settings.siteDescription
    ? `<p class="mx-auto mt-3 max-w-2xl text-sm text-[var(--muted)]">${esc(parts.settings.siteDescription as string)}</p>`
    : "";
  const hero = `<section class="relative overflow-hidden rounded-3xl border border-[var(--border)] bg-gradient-to-br from-[var(--surface)] to-[var(--bg)] px-8 py-12 text-center">` +
    lucideSvg("sparkles", 28, "df-hero-ic") +
    `<h1 class="text-4xl font-bold tracking-tight text-[var(--text)]">${siteTitle}</h1>${tagline}${desc}</section>`;
  const T: Translate = (k, v) => tr(parts.settings, k, v);
  const all = [...parts.hero, ...parts.latest];
  const featured = all[0];
  const rest = all.slice(1);
  let featuredHtml = `<p class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-10 text-center text-[var(--muted)]">${T("empty.posts")}</p>`;
  if (featured) {
    const cats = ((featured.categories || []).slice(0, 3).map(defaultCatPill)).join("");
    featuredHtml = `<article class="group overflow-hidden rounded-3xl border border-[var(--border)] bg-[var(--surface)]">` +
      (featured.featuredImage
        ? `<a href="${esc(featured.url)}" class="block aspect-[21/9] overflow-hidden"><img src="${esc(featured.featuredImage)}" alt="${esc(featured.title)}" class="h-full w-full object-cover transition duration-300 group-hover:scale-105"${R.imgPerfAttrs(featured.featuredImage, { lazy: true, srcset: true })}></a>`
        : "") +
      `<div class="p-6">${cats ? `<div class="mb-2 flex flex-wrap gap-2 text-xs">${cats}</div>` : ""}` +
      `<h2 class="text-2xl font-bold leading-snug text-[var(--text)]"><a href="${esc(featured.url)}" class="transition group-hover:text-[var(--accent)]">${esc(featured.title)}</a></h2>` +
      `<span class="df-featured-tag">${lucideSvg("sparkles", 13)} ${T("post.featured")}</span>` +
      (featured.excerpt ? `<p class="mt-3 line-clamp-3 text-sm text-[var(--muted)]">${esc(featured.excerpt)}</p>` : "") +
      `</div></article>`;
  }
  const grid = rest.map((p, i) => defaultPostCard(p, i, T)).join("");
  return `<div class="space-y-10">${hero}` +
    `<div class="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_300px]"><div><div class="space-y-6">${featuredHtml}` +
    (rest.length ? `<div class="grid grid-cols-1 gap-6 sm:grid-cols-2">${grid}</div>` : "") +
    `</div></div>${defaultAside(parts.cats || [], parts.tags || [], [...parts.hero, ...parts.latest].slice(0, 5), parts.settings, (parts.themeSettings as Record<string, any> | undefined)?.useCustomIcons === true, parts.catCounts)}</div></div>`;
}
function defaultAside(cats: TaxRef[], tags: TaxRef[], recent: PostView[], settings: Record<string, unknown>, showCatIcons = false, catCounts?: Map<number, number>): string {
  const T: Translate = (k, v) => tr(settings, k, v);
  // ---- Category tree -------------------------------------------------------
  // The DB carries a real hierarchy (parentId), and the flat list this used to
  // render threw it away: a parent row and its children looked like unrelated
  // peers, so the sidebar read as 18 loose links instead of 5 groups.
  //
  // Roots are the rows with no parentId, plus any row whose parentId points at a
  // category that no longer exists - an orphan still has to be reachable, and
  // dropping it would hide content behind a link nobody can see. Children are
  // nested under their parent; anything unreachable (a cycle from bad data) is
  // promoted to a root rather than disappearing.
  const byId = new Map(cats.map((c) => [c.id, c]));
  const childOf = new Map<number, TaxRef[]>();
  const roots: TaxRef[] = [];
  for (const c of cats) {
    const pid = c.parentId;
    if (pid != null && pid !== c.id && byId.has(pid)) {
      (childOf.get(pid) ?? childOf.set(pid, []).get(pid)!).push(c);
    } else {
      roots.push(c);
    }
  }
  // A child reachable from two parents (impossible with a single parentId, but
  // cheap to rule out) or looped back to a root would render twice. Mark every
  // category that is claimed by exactly one parent as placed, then treat any
  // unplaced row as a root - that covers both a cycle and a row whose parent
  // chain dangles.
  const placed = new Set<number>();
  for (const [, kids] of childOf) for (const k of kids) placed.add(k.id);
  for (const c of cats) if (!placed.has(c.id) && !roots.includes(c)) roots.push(c);
  const countOf = (c: TaxRef): number | undefined => (catCounts ? catCounts.get(c.id) : undefined);
  // One row of the tree: icon, name, count. `depth` drives the indent so a
  // child reads as belonging to its parent.
  const catRow = (c: TaxRef, depth: number): string => {
    const n = countOf(c);
    return `<a href="${esc(c.url)}" class="df-cat df-cat-d${depth} text-[var(--text)] hover:text-[var(--accent)]">` +
      `<span class="df-cat-ic">${lucideSvg(catIconName(c), depth ? 13 : 14)}</span>` +
      `<span class="df-cat-name">${esc(c.name)}</span>` +
      (n != null ? `<span class="df-cat-n">${n}</span>` : "") +
      `</a>`;
  };
  // A group is a <details> element rather than a div + button: expand/collapse
  // then works with zero JavaScript, is keyboard-operable, keeps its state
  // across a pjax swap (the markup is re-inserted, not recreated), and needs no
  // id (which would collide once several sidebars render).
  //
  // The summary carries ONLY the disclosure control. A <summary> may not wrap
  // an <a> (interactive content inside a summary is not reachable - activating
  // the link toggles the group instead of navigating, and the browser is free
  // to drop the anchor entirely), so the parent's own link sits beside it as a
  // sibling. That also gives the parent row a real click target, which the
  // group-toggle-only version lacked.
  //
  // `open` on the first groups only: a 5-group tree all-collapsed looks broken,
  // all-open is taller than the sidebar.
  let openLeft = 2;
  const catTree = roots
    .map((r) => {
      const kids = childOf.get(r.id) ?? [];
      const n = countOf(r);
      if (!kids.length) {
        return `<li class="df-cat-li df-cat-li-leaf">${catRow(r, 0)}</li>`;
      }
      // A group's count is the sum of its own posts and its children's: a parent
      // usually holds no posts of its own, so showing only its own would make
      // every group read as zero.
      const total = kids.reduce((sum, k) => sum + (countOf(k) ?? 0), 0) + (n ?? 0);
      const open = openLeft-- > 0;
      const sub = kids.map((k) => `<li class="df-cat-li">${catRow(k, 1)}</li>`).join("");
      return `<li class="df-cat-li df-cat-li-group">` +
        `<details class="df-cat-group"${open ? " open" : ""}>` +
        `<summary class="df-cat-summary" title="${T("cat.expand", { name: r.name })}">` +
        `<span class="df-cat-caret">${lucideSvg("chevron-down", 13)}</span>` +
        `<span class="df-cat-groupname">${esc(r.name)}</span>` +
        (total ? `<span class="df-cat-n">${total}</span>` : "") +
        `</summary>` +
        `<ul class="df-cat-sub">${sub}</ul>` +
        `</details>` +
        // The parent is also a destination: its own page lists whatever is
        // filed directly under it.
        `<a href="${esc(r.url)}" class="df-cat df-cat-parent text-[var(--text)] hover:text-[var(--accent)]" aria-label="${T("cat.aria", { name: r.name })}">` +
        `<span class="df-cat-ic">${lucideSvg(catIconName(r), 14)}</span></a>` +
        `</li>`;
    })
    .join("");
  // ---- Recent posts & tags -------------------------------------------------
  const recentLis = recent
    .map(
      (p) =>
        `<li class="df-recent"><a href="${esc(p.url)}" class="df-recent-link text-[var(--text)] hover:text-[var(--accent)]">${esc(p.title)}</a>` +
        `<p class="df-recent-date">${fmtDate(p.publishedAt)}</p></li>`,
    )
    .join("");
  const tagPills = tags
    .map(
      (t) =>
        `<a href="${esc(t.url)}" class="df-tag text-[var(--text)] hover:border-[var(--accent)] hover:text-[var(--accent)]">#${esc(t.name)}</a>`,
    )
    .join("");
  const cardHead = (icon: string, label: string, extra = "") =>
    `<h3 class="df-card-head">${lucideSvg(icon, 15)}<span>${label}</span>${extra}</h3>`;
  const card = (inner: string, cls = "") => `<section class="df-card ${cls}">${inner}</section>`;
  return `<aside class="df-aside">` +
    // The sidebar search is a real field, not a decorative box: the label is
    // screen-reader only, and the icon sits inside the bordered pill as a flex
    // item (an absolutely-positioned overlay escaped the field whenever its
    // containing block was not established). It keeps its own <label for> and
    // the -block box modifier, so it is NOT routed through searchField() -
    // that helper exists for the two copies that share a shape.
    `<form action="/search" method="get" class="df-search-form df-search-form-block" role="search">` +
    `<label class="df-sr-only" for="df-aside-q">${T("search.aria")}</label>` +
    `<span class="df-search-box df-search-box-block">` +
    lucideSvg("search", 16, dfSearchIcon()) +
    `<input id="df-aside-q" name="q" placeholder="${T("search.placeholder")}" class="df-search-input" autocomplete="off"` +
    ` role="combobox" aria-expanded="false" aria-autocomplete="list"` +
    ` aria-controls="df-suggest-aside" aria-label="${T("search.aria")}">` +
    `<kbd class="df-search-kbd">/</kbd>` +
    // Its own panel id: all three fields are on the same page and each drives
    // the list it points at.
    `<div class="df-suggest" id="df-suggest-aside" hidden></div>` +
    `</span></form>` +
    card(
      cardHead("folder", T("sidebar.categories")) +
      `<ul class="df-cat-tree">${catTree || `<li class="df-empty">${T("sidebar.no_categories")}</li>`}</ul>`,
      "df-card-tree",
    ) +
    card(cardHead("tags", T("sidebar.tags")) + `<div class="df-tags">${tagPills || `<span class="df-empty">${T("sidebar.no_tags")}</span>`}</div>`) +
    card(cardHead("clock", T("sidebar.recent")) + `<ul class="df-recent-list">${recentLis || `<li class="df-empty">${T("sidebar.no_posts")}</li>`}</ul>`) +
    `</aside>`;
}
function defaultPager(page: number, totalPages: number, hrefFor: (p: number) => string, t?: Translate): string {
  const L = (k: string) => (t ? t(k) : makeT(DEFAULT_LOCALE)(k));
  if (totalPages <= 1) return "";
  const windowSize = 5;
  let start = Math.max(1, page - Math.floor(windowSize / 2));
  let end = Math.min(totalPages, start + windowSize - 1);
  start = Math.max(1, end - windowSize + 1);
  const pages: number[] = [];
  for (let p = start; p <= end; p++) pages.push(p);
  const cell = (p: number) => {
    const active = p === page;
    return `<a href="${esc(hrefFor(p))}"${active ? ' aria-current="page"' : ""} class="min-w-9 rounded-lg border px-3 py-2 text-center text-sm transition ${active
      ? "border-[var(--accent)] bg-[var(--accent)] text-white"
      : "border-[var(--border)] text-zinc-300 hover:border-[var(--accent)] hover:text-[var(--accent)]"}">${p}</a>`;
  };
  const edge = (label: string, icon: string, p: number) =>
    `<a href="${esc(hrefFor(p))}" class="df-page-edge">${icon}${label}</a>`;
  let out = `<nav class="mt-10 flex items-center justify-center gap-1.5" aria-label="${L("pager.aria")}">`;
  if (page > 1) out += edge(L("pager.prev"), lucideSvg("chevron-left", 15), page - 1);
  if (start > 1) {
    out += cell(1);
    if (start > 2) out += `<span class="px-1 text-zinc-500">…</span>`;
  }
  out += pages.map(cell).join("");
  if (end < totalPages) {
    if (end < totalPages - 1) out += `<span class="px-1 text-zinc-500">…</span>`;
    out += cell(totalPages);
  }
  if (page < totalPages) out += edge(L("pager.next"), lucideSvg("chevron-right", 15), page + 1);
  return out + `</nav>`;
}
/** mirror components/shared/Breadcrumb.tsx。 */
function defaultBreadcrumb(items: { label: string; href?: string }[], t?: Translate): string {
  if (!items.length) return "";
  const spans = items
    .map((c, i) => {
      const last = i === items.length - 1;
      const inner = c.href && !last
        ? `<a href="${esc(c.href)}" class="transition hover:text-[var(--accent)]">${esc(c.label)}</a>`
        : `<span class="${last ? "text-zinc-300" : ""}">${esc(c.label)}</span>`;
      return `<span class="df-meta-item">${inner}${last ? "" : lucideSvg("chevron-right", 12, "text-zinc-600")}</span>`;
    })
    .join("");
  const aria = (t ?? makeT(DEFAULT_LOCALE))("crumb.aria");
  return `<nav aria-label="${aria}" class="flex flex-wrap items-center gap-1 text-xs text-zinc-500">${spans}</nav>`;
}
function defaultListPage(parts: ListParts): string {
  const T: Translate = (k, v) => tr(parts.settings, k, v);
  const cards = parts.items.map((p, i) => defaultPostCard(p, i, T)).join("");
  const pager = parts.showPager !== false ? defaultPager(parts.page, parts.totalPages, parts.hrefFor, T) : "";
  const isBlog = parts.variant === "blog";
  const isCategory = parts.variant === "category";
  const isSearch = parts.variant === "search";
  const isTerm = !isBlog && !isCategory && !isSearch;
  const iconHtml = parts.titleIcon ? lucideSvg(parts.titleIcon, parts.variant === "search" ? 26 : 22, dfIconAccent()) : "";
  const crumbItems: { label: string; href?: string }[] = [{ label: T("crumb.home"), href: "/" }];
  if (isCategory) crumbItems.push({ label: T("crumb.category") });
  else if (isSearch) crumbItems.push({ label: T("crumb.search") });
  else if (isTerm) crumbItems.push({ label: T("crumb.tag") });
  else if (!isBlog) crumbItems.push({ label: T("crumb.page") });
  if (isSearch && (parts.query ?? "").trim()) {
    crumbItems.push({ label: (parts.query ?? "").trim() });
  } else {
    crumbItems.push({ label: parts.crumbLast ?? parts.title });
  }
  const backLink =
    `<div class="mb-6">` +
    defaultBreadcrumb(crumbItems, T) +
    `<h1 class="mt-2${isTerm ? "" : " flex items-center gap-2"} text-3xl font-bold text-zinc-100">` +
    (isTerm ? "" : iconHtml) +
    esc(parts.title) +
    `</h1>` +
    (parts.titleDesc
      ? `<p class="mt-2 text-sm text-zinc-400">${esc(parts.titleDesc)}</p>`
      : parts.sub
        ? `<p class="mt-2 text-sm text-zinc-400">${esc(parts.sub)}</p>`
        : "") +
    `</div>`;
  const headHtml = isBlog
    ? defaultBreadcrumb([{ label: T("crumb.home"), href: "/" }, { label: T("crumb.posts") }], T) +
      `<header class="mb-6 mt-3">` +
      `<h1 class="text-3xl font-bold text-zinc-100">${esc(parts.title)}</h1>` +
      (parts.sub ? `<p class="mt-1 text-sm text-[var(--muted)]">${esc(parts.sub)}</p>` : "") +
      `</header>`
    : backLink;
  const sidebar = parts.sidebarData
    ? defaultAside(parts.sidebarData.cats, parts.sidebarData.tags, parts.sidebarData.posts, parts.settings || {}, parts.sidebarData.showCatIcons === true, parts.sidebarData.catCounts)
    : "";
  const emptyText = isCategory
    ? T("empty.category")
    : isSearch
      ? T("empty.search")
      : isTerm
        ? T("empty.tag")
        : T("empty.posts");
  const listHtml = cards
    ? `<div class="grid grid-cols-1 gap-6 sm:grid-cols-2">${cards}</div>`
    : isSearch && !(parts.query ?? "").trim()
      ? `<div class="grid grid-cols-1 gap-6 sm:grid-cols-2"></div>`
      : `<p class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-10 text-center text-zinc-400">${esc(emptyText)}</p>`;
  return `<div class="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_300px]"><div>` +
    headHtml +
    (parts.extra || "") +
    listHtml +
    pager +
    `</div>${sidebar}</div>`;
}
/**
 * The share block's markup. NO script here.
 *
 * The copy button used to ship an inline `<script>` next to the buttons, and
 * that is why it worked only when the article was opened directly: the block
 * renders inside `<main id="sk-main">`, and a pjax navigation replaces that
 * subtree with `main.innerHTML = ...`. The HTML parser ignores every script
 * inside markup inserted that way, so on every client-side navigation the new
 * page's copy button arrived with nothing bound to it and did nothing when
 * clicked — no error, no console message, just a dead button.
 *
 * The handler now lives in /public/pjax.js, which is loaded once from
 * `<head>` and therefore survives every swap. That file already documents this
 * class of bug; this entry is the second consumer of the same rule.
 */
function defaultShareButtons(title: string, url: string, t?: Translate): string {
  const L = (k: string) => (t ? t(k) : makeT(DEFAULT_LOCALE)(k));
  // https, not http: on an HTTPS site an http:// share link is mixed content,
  // so the browser either blocks it or first loads it over plaintext, leaking
  // the visited URL and getting the visitor flagged by Weibo's own gateway.
  const wb = `https://service.weibo.com/share/share.php?url=${encodeURIComponent(url)}&title=${encodeURIComponent(title)}`;
  // x.com/intent/post is the current endpoint; intent/tweet still redirects, but linking the retired one is an extra hop for no reason.
  const x = `https://x.com/intent/post?url=${encodeURIComponent(url)}&text=${encodeURIComponent(title)}`;
  const mail = `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(url)}`;
  const btn = "df-share-btn";
  // data-url is left empty on purpose: pjax.js falls back to
  // location.href, which is the page the visitor is actually looking at. The
  // server-rendered absolute URL is the page as of render time, and pjax has
  // no way to rewrite an attribute on the markup it swaps in.
  return `<div class="df-share">` +
    `<span class="df-share-label">${lucideSvg("share-2", 15)}${L("post.share")}</span>` +
    `<button type="button" data-share-copy title="${L("post.copy_link")}" class="${btn}">` +
    `${lucideSvg("link", 13)}<span data-share-label>${L("post.copy_label")}</span></button>` +
    `<a href="${esc(wb)}" target="_blank" rel="noopener noreferrer" class="${btn}">${L("post.weibo")}</a>` +
    // Plain text: lucide's `x` is the close glyph, and a brand logo is not
    // worth shipping an icon file for.
    `<a href="${esc(x)}" target="_blank" rel="noopener noreferrer" class="${btn}" aria-label="${L("post.x_aria")}">X</a>` +
    `<a href="${esc(mail)}" class="${btn}">${lucideSvg("mail", 13)}${L("post.email")}</a>` +
    `</div>`;
}
/**
 * Live view counts. No script here either — see defaultShareButtons.
 *
 * The article HTML is render-cached for up to 15s, so the count in the markup
 * can be stale; the real number is fetched after load and written into the
 * [data-views-count] slot. That "after load" has to be driven from
 * pjax.js on the rv:nav event, because this block renders inside
 * <main id="sk-main"> and pjax replaces that subtree wholesale: an inline
 * script inside it runs on a direct page load and then never again, which is
 * why the count stayed at the cached value after a client-side navigation.
 */
function defaultRelatedSection(posts: PostView[], t?: Translate): string {
  const L = (k: string) => (t ? t(k) : makeT(DEFAULT_LOCALE)(k));
  if (!posts.length) return "";
  const cards = posts.map((p) =>
    `<a href="${esc(p.url)}" class="group rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 transition hover:border-[var(--accent)]">` +
    `<h3 class="line-clamp-2 font-medium text-zinc-100 transition group-hover:text-[var(--accent)]">${esc(p.title)}</h3>` +
    (p.publishedAt ? `<p class="mt-2 text-xs text-[var(--muted)]">${fmtDate(p.publishedAt)}</p>` : "") +
    `</a>`).join("");
  return `<section class="mt-10">` +
    `<h2 class="mb-4 flex items-center gap-2 text-lg font-bold text-zinc-100">${lucideSvg("folder-open", 18, dfIconAccent())}${L("post.related")}</h2>` +
    `<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">${cards}</div></section>`;
}
function defaultPostPage(parts: PostPageParts): string {
  const T: Translate = (k, v) => tr(parts.settings, k, v);
  const p = parts.post;
  const cats = (p.categories || []).map(defaultCatPill).join("");
  const author = esc(p.author?.name ?? T("post.author_unknown"));
  const meta = parts.defMetaHtml || "";
  const tags = parts.defTagsHtml || "";
  const firstCat = (p.categories || [])[0];
  const crumb = defaultBreadcrumb([
    { label: T("crumb.home"), href: "/" },
    { label: T("crumb.posts"), href: parts.blogIndex || "/blog" },
    ...(firstCat ? [{ label: firstCat.name, href: firstCat.url }] : []),
    { label: p.title },
  ], T);
  // Table of contents from the body's own h2/h3 anchors (addHeadingIds stamps
  // id="<slug>-h<n>" at render). Native <details>: no JS, collapsed by default
  // so short-ish posts with one or two headings stay uncluttered. Hidden
  // entirely when the body has fewer than two headings.
  const tocItems = [...parts.bodyHtml.matchAll(/<h([23])[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g)]
    .map((m) => ({ level: Number(m[1]), id: m[2], text: m[3].replace(/<[^>]*>/g, "").trim() }))
    .filter((h) => h.text);
  const tocHtml =
    tocItems.length >= 2
      ? `<details class="df-toc mb-6 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-5 py-4">` +
        `<summary class="cursor-pointer text-sm font-semibold text-[var(--text)]">${T("post.toc")}</summary>` +
        `<ul class="mt-3 space-y-1.5 text-sm">` +
        tocItems
          .map(
            (h) =>
              `<li${h.level === 3 ? ' class="ml-4"' : ""}><a href="#${esc(h.id)}" class="text-[var(--muted)] hover:text-[var(--accent)]">${esc(h.text)}</a></li>`,
          )
          .join("") +
        `</ul></details>`
      : "";
  return `<div class="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_300px]"><article id="post-body">` +
    `<header class="mb-6">` +
    // No "back to home" link above the title. The header already carries the
    // site brand as a link to "/", so this was a second control to the same
    // place competing with the breadcrumb right below it.
    crumb +
    (cats ? `<div class="mb-3 mt-3 flex flex-wrap gap-2 text-xs">${cats}</div>` : "") +
    `<h1 class="text-3xl font-bold leading-tight text-[var(--text)]">${esc(p.title)}</h1>` +
    `<div class="mt-3 flex flex-wrap items-center gap-4 text-sm text-[var(--muted)]">` +
    `<span class="df-meta-item">${lucideSvg("user", 14)}${author}</span>` +
    `<span class="df-meta-item">${lucideSvg("calendar", 14)}${fmtDate(p.publishedAt)}</span>` +
    `<span class="df-meta-item" data-views-post="${p.id}">${lucideSvg("eye", 14)}<span data-views-count>${p.views}</span>${T("post.reads")}</span>` +
    (p.commentsCount > 0 ? `<span class="df-meta-item">${lucideSvg("message-circle", 14)}${T("post.comments", { n: p.commentsCount })}</span>` : "") +
    `</div>${meta}</header>` +
    (p.featuredImage ? `<img src="${esc(p.featuredImage)}" alt="${esc(p.title)}" class="mb-6 w-full rounded-2xl border border-[var(--border)] object-cover"${R.imgPerfAttrs(p.featuredImage, { high: true, srcset: true })}>` : "") +
    tocHtml +
    `<div class="prose-cms">${parts.bodyHtml}</div>` +
    (tags || "") +
    defaultShareButtons(p.title, parts.canonical || p.url, T) +
    defaultRelatedSection(parts.relatedTaxonomy || [], T) +
    (parts.postBottom || "") +
    parts.commentsHtml +
    (parts.adjacentHtml || "") +
    `</article>` +
    `<div class="space-y-6">` +
    (parts.sidebarData
      ? defaultAside(parts.sidebarData.cats, parts.sidebarData.tags, parts.sidebarData.posts, parts.settings || {}, parts.sidebarData.showCatIcons === true, parts.sidebarData.catCounts)
      : "") +
    (parts.sidebarWidgets || "") +
    `</div></div>`;
}
function defaultPagePage(parts: PagePageParts): string {
  const p = parts.page;
  return `<div class="mx-auto max-w-3xl"><article>` +
    `<h1 class="text-3xl font-bold leading-tight text-[var(--text)]">${esc(p.title)}</h1>` +
    `<div class="prose-cms mt-8">${parts.bodyHtml}</div>` +
    `</article>${parts.commentsHtml}</div>`;
}
export const chrome: ThemeChrome = {
  slug: "default",
  cssHref: () => themeCssHref("default"),
  // Inlined; see ThemeChrome.cssInline. This is the theme the measurement was
  // taken on, and it is also the one whose CSS is assembled from three sources
  // (the shared form baseline, the body utilities and two files) - so a single
  // <link> was the only way to ship it, and the only thing on the critical path.
  cssInline: () => themeCssContent("default"),
  bodyFix: () => defaultBodyFix,
  headExtra: () => "",
  nav: (settings, items) => defaultNav(settings, items),
  bodyOpen: (settings, items) => `${defaultNav(settings, items)}<main id="sk-main" class="relative mx-auto w-full max-w-5xl flex-1 px-4 py-8">`,
  bodyClose: (settings, footerHtml) => `</main>${footerHtml}</div>`,
  aside: () => "",
  footer: (settings, widgetsHtml) => defaultFooter(settings, widgetsHtml),
  home: defaultHome,
  listPage: defaultListPage,
  postPage: defaultPostPage,
  pagePage: defaultPagePage,
};
