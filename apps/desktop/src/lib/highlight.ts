/**
 * Split `text` into plain runs and `{ mark }` runs for every whitespace-separated term of
 * `query` (case-insensitive, overlapping matches merged). Used for search snippets.
 */
export function highlightTerms(text: string, query: string): (string | { mark: string })[] {
  const terms = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
  if (terms.length === 0 || !text) return [text];
  const lower = text.toLowerCase();
  const ranges: [number, number][] = [];
  for (const t of terms) {
    let from = 0;
    for (;;) {
      const i = lower.indexOf(t, from);
      if (i === -1) break;
      ranges.push([i, i + t.length]);
      from = i + t.length;
    }
  }
  if (ranges.length === 0) return [text];
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  const out: (string | { mark: string })[] = [];
  let pos = 0;
  for (const [a, b] of merged) {
    if (a > pos) out.push(text.slice(pos, a));
    out.push({ mark: text.slice(a, b) });
    pos = b;
  }
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}
