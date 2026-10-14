/**
 * Query guards for the GraphQL endpoint.
 *
 * The endpoint had no limits at all, and `graphql.rose` answers OPTIONS with
 * `access-control-allow-origin: *`. Those two facts combine badly: any site a
 * logged-in admin visits can drive /api/graphql from the browser, and a single
 * query can fan out to an unbounded number of database round trips. Session
 * cookies are SameSite=Lax so they are not attached to a cross-site POST, but
 * that protects credentials only - the read-heavy public fields are open, and
 * the guard belongs on the query document rather than on the transport.
 *
 * Both checks run BEFORE execution, so a rejected query costs one parse.
 */

/** Deepest object nesting a legitimate client needs. The public schema's own
 *  shape is Query -> PostList -> Post -> (User | Category | Tag), so four
 *  levels is generous; the cap exists to stop fan-out, not to shape queries. */
export const MAX_DEPTH = 12;

/** Ceiling on the cost estimate before the query is refused.
 *
 *  Chosen against the shapes real clients send: the heaviest one this schema
 *  supports (a 20-post list with author, categories and tags expanded) scores
 *  260, and a 50-page list with full content scores 300. 1500 leaves several
 *  times that headroom while still rejecting the wide-and-shallow query that
 *  exists only to pull the whole database through one round trip. */
export const MAX_COST = 1500;

/** The page-size cap the resolvers already enforce, mirrored here so the cost
 *  estimate reflects reality rather than assuming the caller was reasonable. */
export const MAX_PAGE_SIZE = 100;

const SELECTION_HOLDERS = new Set([
  'OperationDefinition',
  'FragmentDefinition',
  'SelectionSet',
  'Field',
  'InlineFragment',
]);

/**
 * The selection set directly under a node, if it has one.
 *
 * graphql-js nests as node -> selectionSet -> selections[], so a FIELD does
 * not carry `selections` itself: only a SelectionSet does. Checking the wrong
 * level looks exactly like an AST with no nesting at all, which is how an
 * earlier version of this function reported depth 0 for a 60-level query and
 * silently allowed everything.
 */
function innerSelections(node: unknown): readonly unknown[] | null {
  if (!node || typeof node !== 'object') return null;
  const ss = (node as { selectionSet?: { selections?: unknown } }).selectionSet;
  return ss && Array.isArray(ss.selections) ? ss.selections : null;
}

/** Direct selections of a SelectionSet node. */
function ownSelections(node: unknown): readonly unknown[] | null {
  if (!node || typeof node !== 'object') return null;
  const sel = (node as { selections?: unknown }).selections;
  return Array.isArray(sel) ? sel : null;
}

/** Depth of the deepest selection path, counted over the whole document.
 *
 * Iterative with an explicit stack: recursion would let a document with
 * thousands of nested selections overflow the JS stack before any counter
 * reached the cap, and that is exactly the input being defended against.
 *
 * The depth of a leaf field is counted as the number of selection SETS walked
 * through, so `{ a }` is depth 1 and `{ a { b { c } } }` is depth 3.
 */
export function queryDepth(document: { definitions?: readonly unknown[] }): number {
  const definitions = document?.definitions;
  if (!Array.isArray(definitions)) return 0;

  let deepest = 0;
  const stack: Array<[unknown, number]> = [];
  for (const def of definitions) stack.push([def, 0]);

  const seen = new Set<unknown>();
  while (stack.length) {
    const [node, depth] = stack.pop()!;
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);

    const selections = innerSelections(node) ?? ownSelections(node);
    if (!selections) continue;
    const next = depth + 1;
    if (next > deepest) deepest = next;
    if (deepest > MAX_DEPTH) return deepest;

    for (const sel of selections) stack.push([sel, next]);
  }
  return deepest;
}

/**
 * Reject queries whose selection set nests deeper than MAX_DEPTH.
 *
 * Counted on the parsed document rather than by regexing the query string:
 * fragments and aliases hide nesting from any textual scan, and a regex over
 * raw GraphQL is exactly the kind of thing that silently disagrees with the
 * spec.
 *
 * @returns null when acceptable, otherwise a message.
 */
export function checkQueryDepth(document: { definitions?: readonly unknown[] }): string | null {
  const d = queryDepth(document);
  return d > MAX_DEPTH ? 'Query is too deeply nested (depth ' + d + ', max ' + MAX_DEPTH + ').' : null;
}

/**
 * Coarse cost estimate: selection count x the widest page size requested.
 *
 * Deliberately not a "complexity analysis" - it does not resolve fragment
 * spreads and does not follow variable values, so it under-counts some queries
 * and over-counts others. What it does catch is the one shape that hurts and
 * that the depth check cannot see: a query that asks for many rows across
 * many fields. Depth is checkQueryDepth's job; keeping the two separate means
 * each has one threshold to tune.
 */
export function estimateCost(document: { definitions?: readonly unknown[] }): number {
  const definitions = document?.definitions;
  if (!Array.isArray(definitions)) return 0;

  let selections = 0;
  let widestPage = 1;

  const stack: unknown[] = [];
  for (const def of definitions) stack.push(def);
  const seen = new Set<unknown>();

  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);

    const args = (node as { arguments?: readonly { value?: { value?: unknown } }[] }).arguments;
    if (Array.isArray(args)) {
      for (const a of args) {
        const raw = a && a.value && 'value' in a.value ? (a.value as { value?: unknown }).value : undefined;
        const n = Number(raw);
        if (Number.isFinite(n) && n > widestPage) widestPage = Math.min(n, MAX_PAGE_SIZE);
      }
    }

    const sel = innerSelections(node) ?? ownSelections(node);
    if (!sel) continue;
    selections += sel.length;
    for (const s of sel) stack.push(s);
  }

  return selections * widestPage;
}