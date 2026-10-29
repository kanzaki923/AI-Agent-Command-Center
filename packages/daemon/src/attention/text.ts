/** Longest attention title (one line, spec 20261029 §1.6). */
export const MAX_ATTENTION_TITLE = 80;

/** One line of at most `max` characters (whitespace collapsed, "…" when cut). */
export function oneLine(text: string, max = MAX_ATTENTION_TITLE): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
