import { openUrl } from '@tauri-apps/plugin-opener';
import { Check, Copy } from 'lucide-react';
import { type Token, type Tokens, lexer } from 'marked';
import { type ReactNode, memo, useState } from 'react';
import { isTauri } from '../../lib/platform';
import { highlight } from './highlight';

function openLink(href: string) {
  if (!/^https?:\/\//i.test(href)) return;
  if (isTauri()) void openUrl(href).catch(() => {});
  else window.open(href, '_blank', 'noopener,noreferrer');
}

function Inline({ tokens }: { tokens: Token[] | undefined }): ReactNode {
  if (!tokens) return null;
  return tokens.map((t, i) => <InlineToken key={i} token={t} />);
}

function InlineToken({ token }: { token: Token }): ReactNode {
  switch (token.type) {
    case 'text': {
      const t = token as Tokens.Text;
      return t.tokens ? <Inline tokens={t.tokens} /> : decode(t.text);
    }
    case 'escape':
      return decode((token as Tokens.Escape).text);
    case 'strong':
      return (
        <strong>
          <Inline tokens={(token as Tokens.Strong).tokens} />
        </strong>
      );
    case 'em':
      return (
        <em>
          <Inline tokens={(token as Tokens.Em).tokens} />
        </em>
      );
    case 'del':
      return (
        <del>
          <Inline tokens={(token as Tokens.Del).tokens} />
        </del>
      );
    case 'codespan':
      return <code>{decode((token as Tokens.Codespan).text)}</code>;
    case 'br':
      return <br />;
    case 'link': {
      const l = token as Tokens.Link;
      return (
        <a
          href={l.href}
          title={l.title ?? undefined}
          onClick={(e) => {
            e.preventDefault();
            openLink(l.href);
          }}
        >
          <Inline tokens={l.tokens} />
        </a>
      );
    }
    case 'image': {
      const im = token as Tokens.Image;
      return <span className="text-fg-3">[画像: {im.text || im.href}]</span>;
    }
    case 'html':
      return decode((token as Tokens.HTML).text);
    default:
      return 'raw' in token ? decode(token.raw) : null;
  }
}

/** marked keeps HTML entities in inline text; React escapes on its own. */
function decode(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export function CodeBlock({ code, lang, closed }: { code: string; lang?: string; closed: boolean }) {
  const [copied, setCopied] = useState(false);
  const html = closed ? highlight(code, lang) : null;
  return (
    <div className="group relative overflow-hidden rounded-md border border-line-subtle bg-[color-mix(in_oklch,var(--bg-canvas)_70%,black)]">
      <div className="flex h-7 items-center justify-between border-b border-line-subtle px-3 text-micro text-fg-3">
        <span>{lang || 'text'}</span>
        <button
          type="button"
          aria-label="コードをコピー"
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
          className="flex items-center gap-1 rounded-xs px-1 text-fg-3 opacity-0 group-hover:opacity-100 hover:text-fg"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'コピーしました' : 'コピー'}
        </button>
      </div>
      <pre className="selectable overflow-x-auto px-3 py-2.5 font-mono text-code text-fg">
        {html != null ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{code}</code>}
      </pre>
    </div>
  );
}

function BlockToken({ token, closed }: { token: Token; closed: boolean }): ReactNode {
  switch (token.type) {
    case 'space':
      return null;
    case 'code': {
      const c = token as Tokens.Code;
      return <CodeBlock code={c.text} lang={c.lang?.split(/\s/)[0]} closed={closed} />;
    }
    case 'heading': {
      const h = token as Tokens.Heading;
      const Tag = (`h${Math.min(4, h.depth)}` as 'h1' | 'h2' | 'h3' | 'h4');
      return (
        <Tag>
          <Inline tokens={h.tokens} />
        </Tag>
      );
    }
    case 'paragraph':
      return (
        <p>
          <Inline tokens={(token as Tokens.Paragraph).tokens} />
        </p>
      );
    case 'text': {
      const t = token as Tokens.Text;
      return <p>{t.tokens ? <Inline tokens={t.tokens} /> : decode(t.text)}</p>;
    }
    case 'blockquote':
      return (
        <blockquote>
          {(token as Tokens.Blockquote).tokens.map((t, i) => (
            <BlockToken key={i} token={t} closed={closed} />
          ))}
        </blockquote>
      );
    case 'list': {
      const l = token as Tokens.List;
      const items = l.items.map((it, i) => (
        <li key={i}>
          {it.task && <input type="checkbox" checked={!!it.checked} readOnly className="mr-1.5 align-middle" />}
          {it.tokens.map((t, j) =>
            t.type === 'text' ? (
              <Inline key={j} tokens={(t as Tokens.Text).tokens ?? [t]} />
            ) : (
              <BlockToken key={j} token={t} closed={closed} />
            ),
          )}
        </li>
      ));
      return l.ordered ? <ol start={typeof l.start === 'number' ? l.start : undefined}>{items}</ol> : <ul>{items}</ul>;
    }
    case 'table': {
      const t = token as Tokens.Table;
      return (
        <table>
          <thead>
            <tr>
              {t.header.map((c, i) => (
                <th key={i}>
                  <Inline tokens={c.tokens} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {t.rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j}>
                    <Inline tokens={c.tokens} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    case 'hr':
      return <hr />;
    case 'html':
      return <p>{decode((token as Tokens.HTML).text)}</p>;
    default:
      return 'raw' in token ? <p>{decode(token.raw)}</p> : null;
  }
}

/** A settled block never re-renders: same raw source = same output. */
const MemoBlock = memo(
  function MemoBlock({ token, closed }: { token: Token; closed: boolean }) {
    return <BlockToken token={token} closed={closed} />;
  },
  (a, b) => a.token.raw === b.token.raw && a.closed === b.closed,
);

/** Whether a fenced code block's source includes its closing fence. */
function fenceClosed(raw: string): boolean {
  const lines = raw.trimEnd().split('\n');
  if (lines.length < 2) return false;
  const open = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0]!)?.[1];
  if (!open) return true;
  const last = lines[lines.length - 1]!.trim();
  return last.startsWith(open[0]!.repeat(open.length));
}

/**
 * Markdown rendered block by block (§6.1). Only the last block is re-parsed while
 * streaming; an open code fence renders as code immediately (no paragraph -> code jump),
 * and highlighting is applied once the fence closes.
 */
export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const tokens = lexer(text, { gfm: true, breaks: true });
  const lastIdx = (() => {
    for (let i = tokens.length - 1; i >= 0; i--) if (tokens[i]!.type !== 'space') return i;
    return -1;
  })();
  return (
    <div className={streaming ? 'md md-streaming selectable' : 'md selectable'}>
      {tokens.map((t, i) => {
        const closed = !streaming || i !== lastIdx || (t.type === 'code' && fenceClosed(t.raw));
        return <MemoBlock key={i} token={t} closed={t.type === 'code' ? closed : true} />;
      })}
      {streaming && lastIdx === -1 && <span className="acc-caret" aria-hidden="true" />}
    </div>
  );
}
