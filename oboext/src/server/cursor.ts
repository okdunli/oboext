export type ListCursor = { t?: string; id: number };

const B64URL = /^[A-Za-z0-9_-]+$/;

function fromBase64Url(s: string): string | null {
  if (!B64URL.test(s)) return null;
  try {
    const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
    return Buffer.from(s + pad, "base64").toString("utf8");
  } catch {
    return null;
  }
}

export function encodeCursor(c: ListCursor): string {
  const payload: Record<string, unknown> = { id: c.id };
  if (c.t != null && c.t !== "") payload.t = c.t;
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor(raw: unknown): ListCursor | null {
  if (typeof raw !== "string" || !raw) return null;
  const text = fromBase64Url(raw);
  if (!text) return null;
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const rec = o as Record<string, unknown>;
  const id = rec.id;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return null;
  const t = rec.t;
  if (t !== undefined) {
    if (typeof t !== "string" || !t || t.length > 64) return null;
    return { t, id };
  }
  return { id };
}
