// Page numbers and window offsets ride the query string straight into a SQL
// OFFSET. A non-finite value (?page=Infinity / ?offset=1e309) or a fractional
// one (?page=3.7 / ?offset=2.5) used to reach the driver unchanged and 500 the
// request before any range check could answer, so every reader - public
// loaders, admin lists, the security-log API and GraphQL - funnels through
// these two helpers.
export const PAGE_MAX = 100_000;

const finiteInt = (v: unknown, fallback: number): number => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : fallback;
};

export const pageNum = (v: unknown): number => {
  const n = finiteInt(v, 1);
  return Math.min(Math.max(n, 1), PAGE_MAX);
};

export const offsetNum = (v: unknown): number => Math.max(0, finiteInt(v, 0));
