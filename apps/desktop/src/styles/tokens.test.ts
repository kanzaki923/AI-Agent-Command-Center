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

describe('member colours', () => {
  const css = readFileSync(join(__dirname, 'index.css'), 'utf8');
  const block = (selector: string) => css.slice(css.indexOf(`${selector} {`)).split('\n}')[0]!;
  const value = (b: string, name: string) => new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`).exec(b)?.[1];
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const contrast = (a: string, b: string) => {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x! + 0.05) / (y! + 0.05);
  };

  it('are readable as text (names) on every light ground', () => {
    const light = block(":root[data-theme='light']");
    const grounds = ['bg-app', 'bg-canvas', 'bg-surface'].map((g) => value(light, g)!);
    const low: string[] = [];
    for (let i = 1; i <= 8; i++) {
      const c = value(light, `member-${i}`);
      expect(c, `--member-${i} is set in the light theme`).toBeDefined();
      for (const g of grounds) if (contrast(c!, g) < 4.5) low.push(`--member-${i} ${c} on ${g}: ${contrast(c!, g).toFixed(2)}`);
    }
    expect(low).toEqual([]);
  });
});
