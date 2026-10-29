// Weak content validators, owned by the app.
//
// The framework synthesizes the same pair for its own responses, but it does
// not publish them (they live in the CLI's internals, outside the package's
// exports map). The app answers its own non-HTML responses - RSS, sitemap,
// XML - so it carries the two helpers it needs.
import { createHash } from 'node:crypto';

/** A weak, content-derived validator for the exact bytes going on the wire. */
export function contentEtag(raw: Buffer): string {
  return 'W/"' + createHash('sha1').update(raw).digest('base64url').slice(0, 24) + '"';
}

/** RFC 9110 §13.1.2 `If-None-Match`: a list, `*` matches any current
 *  representation, and the weak comparison ignores the `W/` prefix. */
export function ifNoneMatch(header: string | string[] | undefined | null, etag: string): boolean {
  if (!header) return false;
  const bare = etag.startsWith('W/') ? etag.slice(2) : etag;
  for (const part of (Array.isArray(header) ? header.join(',') : header).split(',')) {
    const token = part.trim();
    if (!token) continue;
    if (token === '*') return true;
    if ((token.startsWith('W/') ? token.slice(2) : token) === bare) return true;
  }
  return false;
}
