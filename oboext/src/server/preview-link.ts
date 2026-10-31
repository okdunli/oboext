// Shareable preview links: an admin can hand out a URL that shows an
// unpublished post or page to anyone, no account needed, until it expires.
//
// The token names exactly ONE content kind and id, plus an expiry; the HMAC
// over that payload is what makes it unforgeable and unguessable without the
// session secret. The kind is inside the signed payload because posts and
// pages are separate id spaces - a token for post 5 must never open page 5.
import { createHmac, timingSafeEqual } from "node:crypto";
import { getSecret } from "./auth.js";
import { getPostRow } from "./queries.js";
import { getPageRowForPreview } from "./pages.js";

export type PreviewKind = "post" | "page";

export const PREVIEW_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SIG_BYTES = 16;
const MAX_TOKEN_LENGTH = 200;
const PAYLOAD_RE = /^[gp]\d{1,10}\.\d{1,12}$/;

function mac(payload: string): Buffer {
  return createHmac("sha256", Buffer.from(getSecret()))
    .update(payload)
    .digest()
    .subarray(0, SIG_BYTES);
}

/** The lifetime a minted link gets: 7 days, or `OBOEXT_PREVIEW_TTL_DAYS`
 *  (1..365) when set. Read per call so a config change needs no restart of the
 *  minting path — the verification side only trusts the signed exp anyway. */
export function previewTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const days = Number(env.OBOEXT_PREVIEW_TTL_DAYS);
  return Number.isFinite(days) && days >= 1 && days <= 365 ? days * 86_400_000 : PREVIEW_TTL_MS;
}

/** A token for one post/page, valid for previewTtlMs() from `now`. */
export function previewTokenFor(kind: PreviewKind, id: number, now = Date.now()): string {
  // A token for "0" or a fraction would verify to null and look like a broken
  // link; refuse the input at the source instead of minting a dead token.
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("previewTokenFor: invalid id");
  const exp = Math.ceil((now + previewTtlMs()) / 1000);
  const payload = `${kind === "page" ? "g" : "p"}${id}.${exp}`;
  return `${Buffer.from(payload).toString("base64url")}.${mac(payload).toString("base64url")}`;
}

/** What a token stands for, or null for anything malformed, forged or
 *  expired. Never throws: a caller decides between 404 and a cache bypass. */
export function verifyPreviewToken(
  token: string | null | undefined,
  now = Date.now(),
): { kind: PreviewKind; id: number } | null {
  if (!token || token.length > MAX_TOKEN_LENGTH) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payload = Buffer.from(token.slice(0, dot), "base64url").toString();
  if (!PAYLOAD_RE.test(payload)) return null;
  const given = Buffer.from(token.slice(dot + 1), "base64url");
  const want = mac(payload);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  const [head, expStr] = payload.split(".");
  if (Number(expStr) * 1000 <= now) return null;
  const id = Number(head.slice(1));
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return { kind: head[0] === "g" ? "page" : "post", id };
}

/** The post row a preview token may show on `slug`, or null. */
export async function previewRowForToken(
  slug: string,
  token: string | null | undefined,
  now = Date.now(),
) {
  const claim = verifyPreviewToken(token, now);
  if (!claim || claim.kind !== "post") return null;
  const row = await getPostRow(slug, { preview: true });
  return row && row.post.id === claim.id ? row : null;
}

/** The page row a preview token may show on `slug`, or null. */
export async function previewPageRowForToken(
  slug: string,
  token: string | null | undefined,
  now = Date.now(),
) {
  const claim = verifyPreviewToken(token, now);
  if (!claim || claim.kind !== "page") return null;
  const row = await getPageRowForPreview(slug);
  return row && row.id === claim.id ? row : null;
}
