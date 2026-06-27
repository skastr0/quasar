/**
 * Pure presentation helpers for the TUI. Layout-neutral: they answer "what text
 * and which ranges", not "which pane" — so they survive whatever the design
 * council settles on.
 */

/** Split a query into lowercased term tokens for matching. */
export const queryTerms = (query: string): readonly string[] =>
  query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\w]/g, ""))
    .filter((t) => t.length >= 2);

/** Inclusive-exclusive [start, end) ranges of query-term hits in `text`. Non-overlapping, ordered. */
export const matchRanges = (text: string, query: string): ReadonlyArray<readonly [number, number]> => {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const hay = text.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const at = hay.indexOf(term, from);
      if (at === -1) break;
      ranges.push([at, at + term.length]);
      from = at + term.length;
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  // merge overlaps
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
};

const collapseWhitespace = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * A one-line snippet of `text`, windowed around the first query-term hit so the
 * match is visible. Falls back to the head of the text when nothing matches.
 */
export const snippet = (text: string, query: string, width = 100): string => {
  const flat = collapseWhitespace(text);
  if (flat.length <= width) return flat;
  const ranges = matchRanges(flat, query);
  if (ranges.length === 0) return `${flat.slice(0, width - 1)}…`;
  const [hitStart] = ranges[0]!;
  const half = Math.floor(width / 2);
  const start = Math.max(0, hitStart - half);
  const end = Math.min(flat.length, start + width);
  const head = start > 0 ? "…" : "";
  const tail = end < flat.length ? "…" : "";
  return `${head}${flat.slice(start, end).trim()}${tail}`;
};

/** Hard-truncate to `n` chars with an ellipsis. */
export const truncate = (text: string, n: number): string =>
  text.length <= n ? text : `${text.slice(0, Math.max(0, n - 1))}…`;

/**
 * The visible window over a list that keeps `selected` on screen, centered when
 * possible and clamped at the ends. Returns a [start, end) slice.
 */
export const windowSlice = (
  selected: number,
  total: number,
  visible: number,
): { readonly start: number; readonly end: number } => {
  if (visible <= 0 || total <= 0) return { start: 0, end: 0 };
  if (total <= visible) return { start: 0, end: total };
  let start = selected - Math.floor(visible / 2);
  start = Math.max(0, Math.min(start, total - visible));
  return { start, end: start + visible };
};
