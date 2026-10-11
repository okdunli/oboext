/**
 * Lucide icon renderer (admin).
 *
 * The full lucide set ships as static per-icon SVG files flattened directly
 * under oboext/public/<kebab>.svg (same prebuilt assets the original app
 * exposes at /icons/*.svg). NOTE: rosefd's build copies public/ one level
 * deep with copyFile and rejects subdirectories (EPERM on Windows - see
 * rosefd/BUG.md), so the icons cannot live in public/icons/. They are
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
  const u = `/public/${name}.svg`;
  return (
    `<span class="adm-ic" aria-hidden="true" style="width:${size}px;height:${size}px;--i:url(${u})` +
    `"></span>`
  );
}
