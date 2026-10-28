// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `text-fg-4` is `--text-disabled` (about 2:1 on the canvas): fine for a disabled control or
 * a decoration, unreadable for information (ui-design §2). Every use must be one of these.
 */
const ALLOWED = [
  /(?:disabled|placeholder|data-\[disabled\]):text-fg-4/, // disabled states, placeholders
  />\s*[·→/—]\s*<\/span>/, // separators and "none" dashes
  /<(?:Chevron\w*|Circle|CornerDownLeft)\b/, // decorative icons
  /transition-transform/, // disclosure chevrons
  /inline-block w-3 text-fg-4 select-none/, // the diff +/− gutter
  /> 0 \? 'text-st-(?:completed|failed)' : 'text-fg-4'/, // a diff side with no change (§10)
  /tabular text-meta text-fg-4', className\)\}>—/, // no timestamp
];

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? tsxFiles(join(dir, d.name))
      : d.name.endsWith('.tsx') && !d.name.endsWith('.test.tsx')
        ? [join(dir, d.name)]
        : [],
  );
}

describe('text tokens', () => {
  it('uses the disabled text colour only for disabled states and decoration', () => {
    const root = join(__dirname, '..');
    const offenders: string[] = [];
    for (const file of tsxFiles(root)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (line.includes('text-fg-4') && !ALLOWED.some((re) => re.test(line))) {
            offenders.push(`${relative(root, file)}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});
