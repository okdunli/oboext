import Link from "next/link";
import { Search } from "lucide-react";
import { getSettings } from "@/lib/services/settings";
import { getMenuByLocation, type MenuNode } from "@/lib/services/menus";
import { getActiveThemeSettings } from "@/lib/services/themes";
import { getPalettePreset, isDarkPalette } from "@/lib/theme-palettes";
import NavTree from "@/components/shared/NavTree";
import ServerIcon from "@/components/shared/ServerIcon";

export default async function oboextLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [settings, header, footer, ts] = await Promise.all([
    getSettings(),
    getMenuByLocation("header"),
    getMenuByLocation("footer"),
    getActiveThemeSettings(),
  ]);

  const useCustomIcons = ts.useCustomIcons === true;
  const renderMenuIcon = useCustomIcons
    ? (n: MenuNode) => <ServerIcon name={n.icon} size={15} className="text-[var(--accent)]" />
    : undefined;

  const paletteKey = typeof ts.palette === "string" ? ts.palette : "indigo";
  const preset = getPalettePreset(paletteKey);
  const dark = preset ? preset.dark : isDarkPalette(paletteKey);
  const glass = ts.enableGlass === true;
  const glow = ts.enableGlow === true;

  const headingClass = dark ? "text-zinc-100" : "text-[var(--text)]";
  const subTextClass = dark ? "text-zinc-400" : "text-[var(--muted)]";
  const faintTextClass = dark ? "text-zinc-500" : "text-[var(--muted)]";
  const headerClass = glass
    ? "sticky top-0 z-30 border-b border-[var(--border)] bg-[var(--header-bg)] backdrop-blur"
    : "sticky top-0 z-30 border-b border-[var(--border)] bg-[var(--bg)]/85";

  return (
    <div className="theme-root relative flex min-h-screen flex-col">
      {glow ? <div className="theme-glow" aria-hidden="true" /> : null}

      <header className={headerClass}>
        <div className="relative mx-auto flex max-w-5xl items-center gap-4 px-4 py-3">
          <Link
            href="/"
            className={`flex items-center gap-2 text-lg font-bold tracking-tight ${headingClass}`}
          >
            {settings.logoUrl ? (
              <img src={settings.logoUrl} alt={settings.siteTitle} className="h-7 w-auto" />
            ) : (
              <>
                <span
                  className="flex h-8 w-8 items-center justify-center rounded-lg"
                  style={{ background: "var(--accent)", color: "var(--accent-text)" }}
                >
                  {settings.siteTitle.slice(0, 1).toUpperCase()}
                </span>
                {settings.siteTitle}
              </>
            )}
          </Link>
          <nav className="ml-2 hidden flex-1 md:block">
            <NavTree
              nodes={header?.items ?? []}
              className="flex flex-wrap items-center"
              renderIcon={renderMenuIcon}
            />
          </nav>
          <form action="/search" method="get" className="ml-auto hidden sm:block">
            <div className="relative">
              <Search
                size={16}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]"
              />
              <input
                name="q"
                placeholder="搜索…"
                className={`w-44 rounded-full border border-[var(--border)] py-1.5 pl-9 pr-3 text-sm outline-none focus:border-[var(--accent)] ${
                  glass ? "bg-[var(--surface)] backdrop-blur" : "bg-[var(--surface)]"
                }`}
              />
            </div>
          </form>
        </div>
      </header>

      <main className="relative mx-auto w-full max-w-5xl flex-1 px-4 py-8">{children}</main>

      <footer className="relative border-t border-[var(--border)] bg-[var(--footer-bg)] px-4 py-8">
        <div className="mx-auto max-w-5xl">
          <nav className="mb-4">
            <NavTree
              nodes={footer?.items ?? []}
              className={`flex flex-wrap items-center gap-1 text-sm ${subTextClass}`}
            />
          </nav>
          <p className={`text-xs ${faintTextClass}`}>
            {settings.footerText || `© ${new Date().getFullYear()} ${settings.siteTitle}`}
          </p>
        </div>
      </footer>
    </div>
  );
}
