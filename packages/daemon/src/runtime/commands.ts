/**
 * Read-only shell commands that run without approval (searching and looking around the
 * workspace: `git status`, `ls`, `grep -rn`, `find -name`, ...). Pure and deliberately
 * narrow: a command qualifies only when
 *
 * - it is ONE simple command: no `;` `&` `|` `<` `>` `$` backticks, parentheses, braces,
 *   backslashes, unquoted globs or `~` at the start of a word, no newlines;
 * - the program is listed below by its bare name (no `./ls`, no `/bin/ls`, no `VAR=x ls`);
 * - every flag is one we know to be read-only for that program (an allowlist, not a
 *   denylist: `find -delete`, `git diff --output`, `rg --pre` and `git -c ...` all fail);
 * - every other argument (paths, and for git also revisions) resolves inside the workspace.
 *
 * Anything else is "not read-only" and goes to approval. Being wrong in that direction only
 * costs a click; the other direction would run a command nobody approved.
 */

export interface ReadOnlyCommandCheck {
  /** Whether a (relative or absolute) path stays inside the workspace. */
  inside: (path: string) => boolean;
}

/** Splits a command into words, or null when it uses anything beyond plain words and quotes. */
export function splitSimpleCommand(command: string): string[] | null {
  const words: string[] = [];
  let cur = '';
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (const ch of command) {
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if ('$`\\!\n\r'.includes(ch)) return null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (inWord) words.push(cur);
      cur = '';
      inWord = false;
      continue;
    }
    if (';&|<>`$(){}\\*?[]!#\n\r'.includes(ch)) return null;
    if (ch === '~' && !inWord) return null;
    cur += ch;
    inWord = true;
  }
  if (quote) return null;
  if (inWord) words.push(cur);
  return words.length > 0 ? words : null;
}

const NUM = /^\d+$/;

interface Spec {
  /** Flags taken as one word. */
  flags: RegExp[];
  /** Flags followed by a value word (validated by the given pattern; null = any value). */
  valueFlags?: Record<string, RegExp | null>;
  /** How non-flag words are read. */
  positional: 'paths' | 'none' | 'pattern-then-paths';
}

const SPECS: Record<string, Spec> = {
  pwd: { flags: [/^-[LP]$/], positional: 'none' },
  ls: { flags: [/^-[a-zA-Z1]+$/], positional: 'paths' },
  cat: { flags: [/^-[nbsvAET]+$/], positional: 'paths' },
  head: {
    flags: [/^-\d+$/, /^-[nc]\d+$/, /^-[qv]$/],
    valueFlags: { '-n': NUM, '-c': NUM },
    positional: 'paths',
  },
  tail: {
    flags: [/^-\d+$/, /^-[nc]\d+$/, /^-[qv]$/],
    valueFlags: { '-n': NUM, '-c': NUM },
    positional: 'paths',
  },
  wc: { flags: [/^-[lwcm]+$/], positional: 'paths' },
  grep: {
    flags: [
      /^-[rRnilEFwvcHhoqsxL]+$/,
      /^-[ABCm]\d+$/,
      /^--(include|exclude|exclude-dir)=[^/\\]+$/,
      /^--(color|colour)=never$/,
      /^--$/,
    ],
    valueFlags: { '-A': NUM, '-B': NUM, '-C': NUM, '-m': NUM, '-e': null },
    positional: 'pattern-then-paths',
  },
  rg: {
    flags: [
      /^-[inlwFcSuvHNs]+$/,
      /^-[ABCm]\d+$/,
      /^--(files|hidden|no-ignore|line-number|ignore-case|smart-case|fixed-strings|count|files-with-matches|no-heading|word-regexp|case-sensitive)$/,
      /^--(glob|type|type-not|max-count|context|after-context|before-context)=[^/\\]+$/,
      /^--$/,
    ],
    valueFlags: {
      '-A': NUM,
      '-B': NUM,
      '-C': NUM,
      '-m': NUM,
      '-e': null,
      '-g': /^[^/\\]+$/,
      '-t': /^\w+$/,
      '-T': /^\w+$/,
    },
    positional: 'pattern-then-paths',
  },
};

/** find: start paths, then only tests (no actions such as -exec / -delete / -fprint). */
const FIND_TESTS_WITH_VALUE: Record<string, RegExp | null> = {
  '-name': null,
  '-iname': null,
  '-path': null,
  '-ipath': null,
  '-type': /^[fdl]$/,
  '-maxdepth': NUM,
  '-mindepth': NUM,
};
const FIND_TESTS_ALONE = new Set(['-print', '-o', '-or', '-a', '-and', '-not', '-empty']);

/** git subcommands that only read; global options before the subcommand are refused. */
const GIT_SUBCOMMANDS = new Set([
  'status',
  'diff',
  'log',
  'show',
  'ls-files',
  'rev-parse',
  'branch',
  'blame',
]);
const GIT_FLAGS: RegExp[] = [
  /^-[sbpuvnz]$/,
  /^-\d+$/,
  /^-[nU]\d+$/,
  /^--$/,
  /^--(oneline|stat|shortstat|numstat|name-only|name-status|cached|staged|patch|no-patch|graph|decorate|all|no-color|abbrev-commit|no-abbrev|short|long|branch|ignored|show-toplevel|show-prefix|show-cdup|abbrev-ref|verify|quiet|word-diff|ignore-space-change|ignore-all-space|reverse|first-parent|merges|no-merges|follow|summary|raw|exit-code|check|others|modified|deleted|exclude-standard|is-inside-work-tree|git-dir|show-current|list|remotes|verbose|ahead-behind|no-renames|full-name|cumulative|dirstat)$/,
  /^--(porcelain|untracked-files|color|decorate|date|format|pretty|since|until|after|before|author|committer|grep|max-count|skip|unified|stat|dirstat)=.*$/,
];
const GIT_VALUE_FLAGS: Record<string, RegExp | null> = { '-n': NUM, '-U': NUM };
/** `git branch` with arguments creates / deletes / renames: only listing flags. */
const GIT_BRANCH_FLAGS =
  /^(-a|-r|-v|-vv|-l|--list|--all|--remotes|--show-current|--verbose|--no-color)$/;

/** Why a command is read-only (for logs), or null when it needs approval. */
export function readOnlyCommandReason(command: string, check: ReadOnlyCommandCheck): string | null {
  const argv = splitSimpleCommand(command.trim());
  if (!argv) return null;
  const [program, ...args] = argv;
  if (!program) return null;
  if (program === 'git') return checkGit(args, check) ? `read-only git ${args[0]}` : null;
  if (program === 'find') return checkFind(args, check) ? 'read-only find' : null;
  const spec = SPECS[program];
  if (!spec) return null;
  return checkWithSpec(spec, args, check) ? `read-only ${program}` : null;
}

function checkWithSpec(spec: Spec, args: string[], check: ReadOnlyCommandCheck): boolean {
  let patternSeen = spec.positional !== 'pattern-then-paths';
  let afterDashes = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!afterDashes && a.startsWith('-') && a !== '-') {
      if (a === '--') {
        afterDashes = true;
        continue;
      }
      const valueRule = spec.valueFlags?.[a];
      if (valueRule !== undefined) {
        const v = args[++i];
        if (v === undefined || (valueRule && !valueRule.test(v))) return false;
        if (a === '-e') patternSeen = true;
        continue;
      }
      if (!spec.flags.some((r) => r.test(a))) return false;
      continue;
    }
    if (spec.positional === 'none') return false;
    if (!patternSeen) {
      patternSeen = true;
      continue;
    }
    if (!check.inside(a)) return false;
  }
  return true;
}

function checkFind(args: string[], check: ReadOnlyCommandCheck): boolean {
  let i = 0;
  for (; i < args.length && !args[i]!.startsWith('-'); i++) {
    if (!check.inside(args[i]!)) return false;
  }
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (FIND_TESTS_ALONE.has(a)) continue;
    const rule = FIND_TESTS_WITH_VALUE[a];
    if (rule === undefined) return false;
    const v = args[++i];
    if (v === undefined || (rule && !rule.test(v))) return false;
  }
  return true;
}

function checkGit(args: string[], check: ReadOnlyCommandCheck): boolean {
  const [sub, ...rest] = args;
  if (!sub || !GIT_SUBCOMMANDS.has(sub)) return false;
  if (sub === 'branch') return rest.every((a) => GIT_BRANCH_FLAGS.test(a));
  let afterDashes = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!afterDashes && a.startsWith('-')) {
      if (a === '--') {
        afterDashes = true;
        continue;
      }
      const rule = GIT_VALUE_FLAGS[a];
      if (rule !== undefined) {
        const v = rest[++i];
        if (v === undefined || (rule && !rule.test(v))) return false;
        continue;
      }
      if (!GIT_FLAGS.some((r) => r.test(a))) return false;
      continue;
    }
    // Revisions ("HEAD~1", "main..topic", "HEAD:src/a.ts") and paths alike must stay inside:
    // a revision resolves to a harmless name under the workspace, "../x" does not.
    const pathPart = a.includes(':') ? a.slice(a.indexOf(':') + 1) : a;
    if (pathPart && !check.inside(pathPart)) return false;
  }
  return true;
}
