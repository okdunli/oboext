// Lucide icon renderer (admin).
const ICON_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function admIcon(name: string, size = 16): string {
  if (!name || !ICON_RE.test(name)) return "";
  const u = `/public/icons/${name}.svg`;
  return (
    `<span class="adm-ic" aria-hidden="true" style="width:${size}px;height:${size}px;--i:url(${u})` +
    `"></span>`
  );
}
