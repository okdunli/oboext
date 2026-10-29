// Query guards for the GraphQL endpoint.

// Deepest object nesting a legitimate client needs.
export const MAX_DEPTH = 12;

// Ceiling on the cost estimate before the query is refused.
export const MAX_COST = 1500;

/** The page-size cap the resolvers already enforce, mirrored here so the cost
 *  estimate reflects reality rather than assuming the caller was reasonable. */
export const MAX_PAGE_SIZE = 100;

// Graphql-js AST node kinds that contain a nested selection set.
const SELECTION_HOLDERS = new Set([
  'OperationDefinition',
  'FragmentDefinition',
  'SelectionSet',
  'Field',
  'InlineFragment',
]);

// The selection set directly under a node, if it has one.
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

// Depth of the deepest selection path, counted over the whole document.
export function queryDepth(document: { definitions?: readonly unknown[] }): number {
  const definitions = document?.definitions;
  if (!Array.isArray(definitions)) return 0;

  let deepest = 0;
  // [node, depth] pairs. Seeded with the definitions themselves at depth 0.
  const stack: Array<[unknown, number]> = [];
  for (const def of definitions) stack.push([def, 0]);

  const seen = new Set<unknown>();
  while (stack.length) {
    const [node, depth] = stack.pop()!;
    if (!node || typeof node !== 'object') continue;
    // Fragment definitions can be cyclic in a malformed document; a visited set
    // keeps this linear instead of hanging.
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

// Coarse cost estimate: selection count x the widest page size requested.
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

    // Read this node's own arguments before descending, so a page-size limit is attributed to the field that carries it.
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