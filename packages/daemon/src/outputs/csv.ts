/**
 * Minimal RFC 4180 CSV: quoted fields (with "" escapes and line breaks inside), CRLF or LF,
 * a UTF-8 BOM is ignored. Enough for tables agents write; not a general-purpose parser.
 */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      i++;
    } else if (c === ',') {
      row.push(field);
      field = '';
      i++;
    } else if (c === '\r' || c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += c === '\r' && src[i + 1] === '\n' ? 2 : 1;
    } else {
      field += c;
      i++;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s =
    typeof v === 'string'
      ? v
      : typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint'
        ? String(v)
        : (JSON.stringify(v) ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A table as CSV text (header line first, LF line ends). */
export function toCsv(columns: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const lines = [columns.map(cell).join(',')];
  for (const r of rows) lines.push(r.map(cell).join(','));
  return `${lines.join('\n')}\n`;
}
