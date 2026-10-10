/**
 * Raw-HTML token registry — the 0.2.0 output channel for trusted HTML.
 *
 * rosezm 0.2.0 routes every `{expr}` text interpolation through the runtime
 * esc(), which page code cannot shadow, and the framework ships no @html
 * primitive. So body-level raw HTML rides a token:
 *   - raw() mints a token whose alphabet contains nothing esc() touches,
 *     so `<!--m:i-->TOKEN[/m]` reaches the response verbatim;
 *   - the rosezm.config.js onResponse hook swaps that marker+token pair for
 *     the trusted HTML before the response leaves the worker;
 *   - removing the marker together with the token means the client never
 *     wires the interpolation (no reactive re-render can print the token).
 *
 * One module instance is bundled into dist/server.js, shared by the config
 * hook and the page chunks (plain .js so the build-time config import and the
 * bundled import resolve the same file). Ids are process-global and unique,
 * so concurrent requests never consume each other's HTML. Consumed ids are
 * deleted on send; the cap only bounds error/leak paths.
 */
const TOKEN_OPEN = "«RV:";
const TOKEN_CLOSE = "»";

let seq = 0;
const htmlById = new Map();
const CAP = 4096;

export function mintRaw(html) {
  const id = ++seq;
  htmlById.set(id, html);
  if (htmlById.size > CAP) htmlById.delete(htmlById.keys().next().value);
  return TOKEN_OPEN + id + TOKEN_CLOSE;
}

/** Consume one token's HTML. Returns undefined once taken / unknown. */
export function takeRaw(id) {
  const html = htmlById.get(id);
  if (html !== undefined) htmlById.delete(id);
  return html;
}
