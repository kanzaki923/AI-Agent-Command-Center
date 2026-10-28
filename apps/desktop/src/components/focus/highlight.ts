import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const LANGS = {
  bash,
  css,
  diff,
  go,
  java,
  javascript,
  json,
  markdown,
  powershell,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
};
for (const [name, def] of Object.entries(LANGS)) hljs.registerLanguage(name, def);
hljs.registerAliases(['sh', 'shell', 'zsh', 'console'], { languageName: 'bash' });
hljs.registerAliases(['js', 'jsx', 'mjs', 'cjs'], { languageName: 'javascript' });
hljs.registerAliases(['ts', 'tsx', 'mts'], { languageName: 'typescript' });
hljs.registerAliases(['html', 'svg'], { languageName: 'xml' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });
hljs.registerAliases(['py'], { languageName: 'python' });
hljs.registerAliases(['rs'], { languageName: 'rust' });
hljs.registerAliases(['ps1', 'pwsh'], { languageName: 'powershell' });
hljs.registerAliases(['md'], { languageName: 'markdown' });
hljs.registerAliases(['patch'], { languageName: 'diff' });

const cache = new Map<string, string>();
const MAX_CACHE = 300;
/** Don't block a frame on huge blocks; they stay plain. */
const MAX_HIGHLIGHT_CHARS = 60_000;

/**
 * Highlighted HTML for a *closed* code block (hljs escapes the source). Memoised by
 * language + text so re-renders never re-highlight. Returns null when not highlightable.
 */
export function highlight(code: string, lang: string | undefined): string | null {
  if (code.length > MAX_HIGHLIGHT_CHARS) return null;
  const language = lang && hljs.getLanguage(lang) ? lang : null;
  if (!language) return null;
  const key = `${language}\u0000${code}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const html = hljs.highlight(code, { language, ignoreIllegals: true }).value;
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!);
  cache.set(key, html);
  return html;
}
