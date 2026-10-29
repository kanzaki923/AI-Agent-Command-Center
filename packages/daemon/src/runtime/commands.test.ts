import { describe, expect, it } from 'vitest';
import { readOnlyCommandReason, splitSimpleCommand } from './commands';
import { isInside } from './policy';

const WS = '/work/ws';
const inside = (p: string) => isInside(p, WS, 'linux');
const ro = (command: string) => readOnlyCommandReason(command, { inside }) !== null;

describe('splitSimpleCommand', () => {
  it('splits plain words and quotes', () => {
    expect(splitSimpleCommand('git log --oneline -5')).toEqual(['git', 'log', '--oneline', '-5']);
    expect(splitSimpleCommand(`grep -rn 'a b*' "src dir"`)).toEqual([
      'grep',
      '-rn',
      'a b*',
      'src dir',
    ]);
    expect(splitSimpleCommand("find . -name '*.ts'")).toEqual(['find', '.', '-name', '*.ts']);
    expect(splitSimpleCommand('git show HEAD~1')).toEqual(['git', 'show', 'HEAD~1']);
  });

  it('refuses anything beyond one simple command', () => {
    for (const c of [
      'ls; rm -rf /',
      'ls && rm x',
      'ls | sh',
      'ls > out',
      'cat < /etc/passwd',
      'echo $(id)',
      'echo `id`',
      'echo $HOME',
      'cat "$HOME/x"',
      'ls *.ts',
      'ls ~/x',
      'cat src\\a.ts',
      'ls\nrm x',
      "echo 'unterminated",
      'ls & ',
      'ls {a,b}',
      '',
    ]) {
      expect(splitSimpleCommand(c), c).toBeNull();
    }
  });
});

describe('readOnlyCommandReason', () => {
  it('allows looking around and searching inside the workspace', () => {
    for (const c of [
      'pwd',
      'ls',
      'ls -la src',
      'cat README.md',
      'head -n 20 src/a.ts',
      'tail -50 src/a.ts',
      'wc -l src/a.ts',
      'grep -rn TODO src',
      "grep -rn --include='*.ts' -e 'foo bar' .",
      'grep -A 3 needle README.md',
      'rg -n foo src',
      "rg -g '*.ts' foo",
      "find . -name '*.ts' -type f",
      'find src -maxdepth 2 -iname readme.md',
      'git status',
      'git status --porcelain=v1 -b',
      'git diff',
      'git diff --stat HEAD~1',
      'git diff --cached -- src/a.ts',
      'git log --oneline -5',
      "git log --format='%h %s' -n 3",
      'git show HEAD:src/a.ts',
      'git branch',
      'git branch -a',
      'git rev-parse --show-toplevel',
      'git ls-files',
      'git blame src/a.ts',
    ]) {
      expect(ro(c), c).toBe(true);
    }
  });

  it('refuses commands with side effects, escapes or unknown flags', () => {
    for (const c of [
      // not on the list / not bare names
      'rm -rf build',
      'node -e 1',
      '/bin/ls',
      './ls',
      'FOO=1 ls',
      'sudo ls',
      // paths outside the workspace
      'cat ../other/secret',
      'cat /etc/passwd',
      'ls /',
      'grep -rn key /home/me',
      'find / -name id_rsa',
      'git diff ../other',
      'git show HEAD:../../x',
      // writing / executing flags
      "find . -name '*.ts' -delete",
      'find . -exec rm {} ;',
      'find . -name x -fprint out',
      'tail -f log.txt',
      'grep -f patterns.txt src',
      'rg --pre cat foo',
      'git diff --output=out.patch',
      'git diff --no-index README.md ../other/x',
      'git log --output=x',
      'git blame --contents ../x src/a.ts',
      // git subcommands / options that change things or run code
      'git -c core.pager=sh log',
      'git --git-dir=/x status',
      'git config core.fsmonitor evil',
      'git commit -m x',
      'git checkout main',
      'git branch topic',
      'git branch -D main',
      'git stash',
      'git push',
      'git log -p --ext-diff',
      // malformed value flags
      'head -n',
      'head -n abc README.md',
      'grep -A x foo .',
      'find . -type q',
      'find . -maxdepth',
    ]) {
      expect(ro(c), c).toBe(false);
    }
  });

  it('checks paths with the platform rules (Windows: case-insensitive, drive letters)', () => {
    const win = (p: string) => isInside(p, 'C:\\acc\\ws', 'win32');
    expect(readOnlyCommandReason('cat src/a.ts', { inside: win })).toBe('read-only cat');
    expect(readOnlyCommandReason('cat c:/ACC/ws/README.md', { inside: win })).toBe('read-only cat');
    expect(readOnlyCommandReason('cat D:/acc/ws/x', { inside: win })).toBeNull();
    expect(readOnlyCommandReason('git show HEAD:C:/Windows/x', { inside: win })).toBeNull();
  });
});
