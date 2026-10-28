import { openUrl } from '@tauri-apps/plugin-opener';
import { type Token, type Tokens, lexer } from 'marked';
import { type ReactNode, memo } from 'react';
import { isTauri } from '../../lib/platform';
import { CopyButton } from '../ui/CopyButton';
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

export function CodeBlock({
  code,
  lang,
  closed,
  tail,
}: {
  code: string;
  lang?: string;
  closed: boolean;
  /** The streaming caret, at the end of an open fence. */
  tail?: ReactNode;
}) {
  const html = closed ? highlight(code, lang) : null;
  return (
    <div className="acc-code group relative overflow-hidden rounded-md border border-line-subtle">
      <div className="flex h-7 items-center justify-between border-b border-line-subtle pr-1 pl-3 text-micro text-fg-3">
        <span>{lang || 'text'}</span>
        {/* Visible on hover, and always reachable by keyboard (focus shows it). */}
        <CopyButton
          text={code}
          label="コードをコピー"
          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        />
      </div>
      <pre className="selectable overflow-x-auto px-3 py-2.5 font-mono text-code text-fg">
        {html != null ? (
          <code dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <code>
            {code}
            {tail}
          </code>
        )}
      </pre>
    </div>
  );
}

function BlockToken({ token, closed, tail }: { token: Token; closed: boolean; tail?: ReactNode }): ReactNode {
  switch (token.type) {
    case 'space':
      return null;
    case 'code': {
      const c = token as Tokens.Code;
      return <CodeBlock code={c.text} lang={c.lang?.split(/\s/)[0]} closed={closed} tail={tail} />;
    }
    case 'heading': {
      const h = token as Tokens.Heading;
      const Tag = (`h${Math.min(4, h.depth)}` as 'h1' | 'h2' | 'h3' | 'h4');
      return (
        <Tag>
          <Inline tokens={h.tokens} />
          {tail}
        </Tag>
      );
    }
    case 'paragraph':
      return (
        <p>
          <Inline tokens={(token as Tokens.Paragraph).tokens} />
          {tail}
        </p>
      );
    case 'text': {
      const t = token as Tokens.Text;
      return (
        <p>
          {t.tokens ? <Inline tokens={t.tokens} /> : decode(t.text)}
          {tail}
        </p>
      );
    }
    case 'blockquote': {
      const inner = (token as Tokens.Blockquote).tokens;
      return (
        <blockquote>
          {inner.map((t, i) => (
            <BlockToken key={i} token={t} closed={closed} tail={i === inner.length - 1 ? tail : undefined} />
          ))}
        </blockquote>
      );
    }
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
          {i === l.items.length - 1 && tail}
        </li>
      ));
      return l.ordered ? <ol start={typeof l.start === 'number' ? l.start : undefined}>{items}</ol> : <ul>{items}</ul>;
    }
    case 'table': {
      const t = token as Tokens.Table;
      return (
        <>
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
          {tail}
        </>
      );
    }
    case 'hr':
      return (
        <>
          <hr />
          {tail}
        </>
      );
    case 'html':
      return (
        <p>
          {decode((token as Tokens.HTML).text)}
          {tail}
        </p>
      );
    default:
      return 'raw' in token ? (
        <p>
          {decode(token.raw)}
          {tail}
        </p>
      ) : null;
  }
}

/** A settled block never re-renders: same raw source = same output. */
const MemoBlock = memo(
  function MemoBlock({ token, closed, tail }: { token: Token; closed: boolean; tail?: ReactNode }) {
    return <BlockToken token={token} closed={closed} tail={tail} />;
  },
  (a, b) => a.token.raw === b.token.raw && a.closed === b.closed && a.tail === b.tail,
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

const LEX = { gfm: true, breaks: true } as const;

export interface LexCache {
  text: string;
  tokens: Token[];
}

/**
 * Tokens for `text`, re-lexing only from the start of the last block when the text grew by
 * appending (streaming). Earlier blocks are final once a later block has started, so a
 * 20,000-character answer costs one block per frame, not the whole message.
 */
export function lexIncremental(text: string, prev: LexCache | null): LexCache {
  if (!prev || !text.startsWith(prev.text) || prev.tokens.length < 2) {
    return { text, tokens: lexer(text, LEX) };
  }
  // Keep everything before the last non-space block; it cannot change by appending.
  let keep = prev.tokens.length - 1;
  while (keep > 0 && prev.tokens[keep]!.type === 'space') keep--;
  // The block before the last may still merge with it (a paragraph absorbing a setext
  // underline, a list continuing): re-lex from one block earlier to be safe.
  keep = Math.max(0, keep - 1);
  const kept = prev.tokens.slice(0, keep);
  const offset = kept.reduce((n, t) => n + t.raw.length, 0);
  if (text.slice(0, offset) !== prev.text.slice(0, offset)) return { text, tokens: lexer(text, LEX) };
  return { text, tokens: [...kept, ...lexer(text.slice(offset), LEX)] };
}

/**
 * Tokens of finished messages, by text. A long conversation re-renders its visible blocks
 * when the list around them changes; none of them should be lexed twice.
 */
const settled = new Map<string, Token[]>();
const MAX_SETTLED = 400;
function lexSettled(text: string): Token[] {
  const hit = settled.get(text);
  if (hit) return hit;
  const tokens = lexer(text, LEX);
  if (settled.size >= MAX_SETTLED) settled.delete(settled.keys().next().value!);
  settled.set(text, tokens);
  return tokens;
}

/** Lexing caches of in-flight streams (one per stream; old ones fall out). */
const lexCaches = new Map<string, LexCache>();
const MAX_LEX_CACHES = 24;

/**
 * The streaming caret (§3.2): 2px × 1em at the very end of the text. Remounted on every
 * update so its blink restarts — it stays solid while text flows and blinks once it pauses.
 */
function Caret({ at }: { at: number }) {
  return <span key={at} className="acc-caret" aria-hidden="true" />;
}

/**
 * Markdown rendered block by block (§6.1). Only the last block is re-parsed while
 * streaming; an open code fence renders as code immediately (no paragraph -> code jump),
 * and highlighting is applied once the fence closes.
 */
export function Markdown({
  text,
  streaming = false,
  streamId,
}: {
  text: string;
  streaming?: boolean;
  /** The streaming message id: keys the incremental lexing cache. */
  streamId?: string;
}) {
  let tokens: Token[];
  if (streaming && streamId) {
    const lexed = lexIncremental(text, lexCaches.get(streamId) ?? null);
    lexCaches.delete(streamId);
    lexCaches.set(streamId, lexed);
    if (lexCaches.size > MAX_LEX_CACHES) lexCaches.delete(lexCaches.keys().next().value!);
    tokens = lexed.tokens;
  } else {
    tokens = lexSettled(text);
  }
  const lastIdx = (() => {
    for (let i = tokens.length - 1; i >= 0; i--) if (tokens[i]!.type !== 'space') return i;
    return -1;
  })();
  const caret = streaming ? <Caret at={text.length} /> : undefined;
  return (
    <div className={streaming ? 'md md-streaming selectable' : 'md selectable'}>
      {tokens.map((t, i) => {
        const closed = !streaming || i !== lastIdx || (t.type === 'code' && fenceClosed(t.raw));
        return (
          <MemoBlock
            key={i}
            token={t}
            closed={t.type === 'code' ? closed : true}
            tail={i === lastIdx ? caret : undefined}
          />
        );
      })}
      {streaming && lastIdx === -1 && caret}
    </div>
  );
}
