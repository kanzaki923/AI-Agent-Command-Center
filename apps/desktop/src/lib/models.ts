/** `anthropic/claude-sonnet-4-5` -> `sonnet` (compact model label for dense rows). */
export function shortModel(model: string | null | undefined): string {
  if (!model) return '';
  const last = model.split('/').pop() ?? model;
  const m = /(opus|sonnet|haiku|gpt-[\w.]+|gemini[\w.-]*|o\d[\w-]*|mock[\w-]*)/i.exec(last);
  return (m?.[1] ?? last).toLowerCase();
}

/** Rough relative price from the model family (shown as $ / $$ / $$$ in the picker). */
export function relativeCost(id: string): string {
  const s = id.toLowerCase();
  if (/opus|gpt-5(?!-mini)|o1|o3(?!-mini)|ultra/.test(s)) return '$$$';
  if (/haiku|mini|flash|nano|mock|lite|small/.test(s)) return '$';
  return '$$';
}
