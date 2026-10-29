// Key-order-insensitive JSON comparison helpers (pure, no DB): used by the
// editor autodraft restore hint so same-content blocks with different key
// order do not count as "different" and trigger a pointless restore banner.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}

// djb2 over the canonical form — good enough for "is this the same content".
export function hashCanonical(value: unknown): string {
  const s = canonicalJson(value);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}
