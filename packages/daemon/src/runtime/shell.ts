/**
 * A small, conservative shell parser for the tool policy (not an interpreter): splits a
 * command line into simple commands (`;` `&&` `||` `|` `&` newlines), words (quotes and
 * escapes removed) and redirection targets, and collects the text of command substitutions
 * (`$(...)`, backticks, `<(...)`) so the caller can check them as commands too.
 *
 * Expansions are NOT performed: `$HOME/x` stays `$HOME/x` and `*.ts` stays `*.ts`. The caller
 * treats anything it cannot read for sure as the riskier option.
 */

export type ShellDialect = 'posix' | 'powershell';

export interface ShellCommand {
  /** Words after leading `NAME=value` assignments (posix). */
  argv: string[];
  /** Redirection targets written to (`>`, `>>`, `&>`, `2>` ...). */
  writes: string[];
  /** Redirection sources read from (`<`). */
  reads: string[];
  /** Ends with a single `&`: runs in the background (posix). */
  background: boolean;
  /** Reads its stdin from the previous command (`a | b`). */
  piped: boolean;
  /** Inner text of command / process substitutions in this command. */
  substitutions: string[];
}

export interface ShellParse {
  commands: ShellCommand[];
  /** False when the text could not be read completely (unbalanced quotes, too long ...). */
  complete: boolean;
}

const MAX_LENGTH = 20_000;

function emptyCommand(piped: boolean): ShellCommand {
  return { argv: [], writes: [], reads: [], background: false, piped, substitutions: [] };
}

/** Index just after the `)` closing the substitution whose `(` is at `open`, or -1. */
function closeParen(text: string, open: number): number {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"') i++;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '\\') i++;
    else if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

export function parseShell(text: string, dialect: ShellDialect = 'posix'): ShellParse {
  const commands: ShellCommand[] = [];
  let complete = text.length <= MAX_LENGTH;
  const src = complete ? text : text.slice(0, MAX_LENGTH);
  const escape = dialect === 'powershell' ? '`' : '\\';

  let cmd = emptyCommand(false);
  let word = '';
  let inWord = false;
  let redirect: 'write' | 'read' | 'herestring' | null = null;
  /** Heredoc delimiters whose bodies start at the next newline. */
  const heredocs: string[] = [];
  let heredocPending = false;

  const endWord = () => {
    if (!inWord) return;
    if (redirect === 'write') {
      if (!/^&[\d-]$/.test(word)) cmd.writes.push(word);
    } else if (redirect === 'read') cmd.reads.push(word);
    else if (redirect === 'herestring') {
      // data, not a path
    } else if (heredocPending) {
      heredocs.push(word.replace(/^-/, ''));
      heredocPending = false;
    } else cmd.argv.push(word);
    if (redirect) redirect = null;
    word = '';
    inWord = false;
  };
  const endCommand = (next: 'pipe' | 'seq' | 'background') => {
    endWord();
    if (next === 'background') cmd.background = true;
    if (dialect === 'posix') {
      while (cmd.argv.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd.argv[0]!)) {
        cmd.argv.shift();
      }
      if (cmd.argv.length === 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd.argv[0]!)) cmd.argv = [];
    }
    if (cmd.argv.length > 0 || cmd.writes.length > 0 || cmd.substitutions.length > 0) {
      commands.push(cmd);
    }
    cmd = emptyCommand(next === 'pipe');
  };
  const substitution = (open: number): number => {
    const end = closeParen(src, open);
    if (end < 0) {
      complete = false;
      cmd.substitutions.push(src.slice(open + 1));
      return src.length;
    }
    cmd.substitutions.push(src.slice(open + 1, end - 1));
    return end;
  };

  let quote: "'" | '"' | null = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    const next = src[i + 1];

    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === escape && next !== undefined) {
        word += next;
        i++;
      } else if (ch === '$' && next === '(') {
        i = substitution(i + 1) - 1;
        word += '$(…)';
      } else if (ch === '`' && dialect === 'posix') {
        const end = src.indexOf('`', i + 1);
        if (end < 0) {
          complete = false;
          break;
        }
        cmd.substitutions.push(src.slice(i + 1, end));
        word += '$(…)';
        i = end;
      } else word += ch;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
      continue;
    }
    if (ch === escape && next !== undefined) {
      if (next === '\n') {
        i++;
        continue; // line continuation
      }
      word += next;
      inWord = true;
      i++;
      continue;
    }
    if (ch === '\r') continue;
    if (ch === '\n') {
      endCommand('seq');
      if (heredocs.length > 0) {
        // Skip heredoc bodies: lines up to each delimiter are data.
        for (const delim of heredocs.splice(0)) {
          for (;;) {
            const eol = src.indexOf('\n', i + 1);
            const line = src.slice(i + 1, eol < 0 ? src.length : eol).replace(/\r$/, '');
            i = eol < 0 ? src.length : eol;
            if (line.trim() === delim || eol < 0) break;
          }
        }
      }
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      endWord();
      continue;
    }
    if (ch === '#' && !inWord) {
      const eol = src.indexOf('\n', i);
      i = (eol < 0 ? src.length : eol) - 1;
      continue;
    }
    if ((ch === '$' || ch === '<' || ch === '>' || ch === '@') && next === '(') {
      if (ch === '@' && dialect !== 'powershell') {
        word += ch;
        inWord = true;
        continue;
      }
      if ((ch === '<' || ch === '>') && inWord) endWord();
      i = substitution(i + 1) - 1;
      word += '$(…)';
      inWord = true;
      continue;
    }
    if (ch === '`' && dialect === 'posix') {
      const end = src.indexOf('`', i + 1);
      if (end < 0) {
        complete = false;
        break;
      }
      cmd.substitutions.push(src.slice(i + 1, end));
      word += '$(…)';
      inWord = true;
      i = end;
      continue;
    }
    if (ch === ';') {
      endCommand('seq');
      continue;
    }
    if (ch === '|') {
      if (next === '|') {
        endCommand('seq');
        i++;
      } else {
        endCommand('pipe');
        if (next === '&') i++;
      }
      continue;
    }
    if (ch === '&') {
      if (next === '&') {
        endCommand('seq');
        i++;
        continue;
      }
      if (next === '>') {
        // &> / &>> file
        endWord();
        redirect = 'write';
        i += src[i + 2] === '>' ? 2 : 1;
        continue;
      }
      if (dialect === 'powershell') {
        // Call operator (`& "C:\x.exe" args`) unless it ends the statement.
        const rest = src.slice(i + 1).match(/^[ \t]*(\r?\n|;|$)/);
        if (rest) endCommand('background');
        else endWord();
        continue;
      }
      endCommand('background');
      continue;
    }
    if (ch === '>' || ch === '<') {
      // A bare fd number before the operator ("2>") is not a word.
      if (inWord && /^\d+$/.test(word)) {
        word = '';
        inWord = false;
      } else if (dialect === 'powershell' && inWord && word === '*') {
        word = '';
        inWord = false;
      } else endWord();
      if (ch === '<' && next === '<') {
        if (src[i + 2] === '<') {
          redirect = 'herestring';
          i += 2;
        } else {
          heredocPending = true;
          i += src[i + 2] === '-' ? 2 : 1;
        }
        continue;
      }
      redirect = ch === '>' ? 'write' : 'read';
      if (next === '>' || next === '|') i++;
      if (src[i + 1] === '&') {
        // 2>&1 / >&2: duplicate a descriptor, no file.
        const m = /^&[\d-]/.exec(src.slice(i + 1));
        if (m) {
          redirect = null;
          i += m[0].length;
        }
      }
      continue;
    }
    if (!inWord && (ch === '(' || ch === ')' || ch === '{' || ch === '}')) {
      endWord();
      continue;
    }
    if (inWord && ch === ')') {
      endWord();
      continue;
    }
    word += ch;
    inWord = true;
  }
  if (quote) complete = false;
  endCommand('seq');
  return { commands, complete };
}

/** Quote a word back for the read-only allowlist check, or null when it cannot be. */
export function quoteWord(w: string): string | null {
  if (/^[\w@%+=:,./-]+$/.test(w)) return w;
  if (w.includes("'")) return null;
  return `'${w}'`;
}
