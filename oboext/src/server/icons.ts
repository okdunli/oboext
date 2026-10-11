/**
 * Lucide icon renderer (admin).
 *
 * The full lucide set ships as static per-icon SVG files under
 * oboext/public/icons/<kebab>.svg (rosefd >= 0.3.2 copies public/
 * recursively; earlier versions flattened everything at the root). They are
 * coloured through a CSS mask + currentColor (.adm-ic in admin.css), so one
 * generic span renders any icon and inherits text colour for hover/active
 * states - zero client JS.
 *
 * The .rose templates emit the returned string with {@html}; call sites pass
 * literal kebab names, but we still validate to keep the attribute safe.
 */
const ICON_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function admIcon(name: string, size = 16): string {
  if (!name || !ICON_RE.test(name)) return "";
  const u = `/public/icons/${name}.svg`;
  return (
    `<span class="adm-ic" aria-hidden="true" style="width:${size}px;height:${size}px;--i:url(${u})` +
    `"></span>`
  );
}
