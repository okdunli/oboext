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
