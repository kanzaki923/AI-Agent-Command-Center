import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Settings } from '@acc/protocol';
import { describe, expect, it } from 'vitest';
import {
  allowlistedEnv,
  buildChildEnv,
  envKeys,
  normalizeAnthropicBaseUrl,
  resolveModelRouting,
} from './env';
import { decideToolPermission, isInside, realpathDeep } from './policy';
import { approvalDetailFor, approvalTitleFor, describeToolActivity } from './tools';

const POSIX = '/work/ws';
const WIN = 'C:\\acc\\worktrees\\ws1';

const decide = (
  toolName: string,
  input: unknown,
  cwd = POSIX,
  platform: NodeJS.Platform = 'linux',
) => decideToolPermission({ toolName, input, cwd, platform }).decision;

describe('isInside', () => {
  it('handles posix paths', () => {
    expect(isInside('src/a.ts', POSIX, 'linux')).toBe(true);
    expect(isInside('/work/ws', POSIX, 'linux')).toBe(true);
    expect(isInside('/work/ws/deep/x', POSIX, 'linux')).toBe(true);
    expect(isInside('../other/x', POSIX, 'linux')).toBe(false);
    expect(isInside('/work/ws-evil/x', POSIX, 'linux')).toBe(false);
    expect(isInside('/etc/passwd', POSIX, 'linux')).toBe(false);
    expect(isInside('src/../../x', POSIX, 'linux')).toBe(false);
    expect(isInside('..foo/x', POSIX, 'linux')).toBe(true);
    expect(isInside('~/.ssh/id_rsa', POSIX, 'linux')).toBe(false);
  });

  it('handles windows paths case-insensitively', () => {
    expect(isInside('src\\a.ts', WIN, 'win32')).toBe(true);
    expect(isInside('c:\\ACC\\worktrees\\WS1\\x.ts', WIN, 'win32')).toBe(true);
    expect(isInside('C:/acc/worktrees/ws1/x.ts', WIN, 'win32')).toBe(true);
    expect(isInside('C:\\Users\\me\\.ssh\\id_rsa', WIN, 'win32')).toBe(false);
    expect(isInside('D:\\acc\\worktrees\\ws1\\x', WIN, 'win32')).toBe(false);
    expect(isInside('..\\ws2\\x', WIN, 'win32')).toBe(false);
  });
});

describe('decideToolPermission', () => {
  it('allows read-only tools inside the workspace', () => {
    expect(decide('Read', { file_path: '/work/ws/src/a.ts' })).toBe('allow');
    expect(decide('Read', { file_path: 'src/a.ts' })).toBe('allow');
    expect(decide('Grep', { pattern: 'foo' })).toBe('allow');
    expect(decide('Glob', { pattern: '**/*.ts' })).toBe('allow');
    expect(decide('LS', { path: '/work/ws' })).toBe('allow');
    expect(decide('TodoWrite', { todos: [] })).toBe('allow');
  });

  it('asks (careful) for reads outside the workspace and denies credentials', () => {
    expect(decide('Read', { file_path: '/home/me/.aws/credentials' })).toBe('deny');
    expect(decide('Grep', { pattern: 'key', path: '/etc' })).toBe('ask');
    expect(decide('Glob', { pattern: '/home/me/**/*.pem' })).toBe('ask');
    expect(decide('Glob', { pattern: '/work/ws/**/*.ts' })).toBe('allow');
  });

  it('allows edits inside the workspace and denies them outside', () => {
    expect(
      decide('Edit', { file_path: '/work/ws/src/a.ts', old_string: 'a', new_string: 'b' }),
    ).toBe('allow');
    expect(decide('Write', { file_path: 'notes/x.md', content: '' })).toBe('allow');
    expect(decide('MultiEdit', { file_path: '/work/other/a.ts' })).toBe('deny');
    expect(decide('Write', { file_path: '../escape.txt' })).toBe('deny');
    expect(decide('Write', { content: 'no path' })).toBe('deny');
    expect(decide('Write', { file_path: 'C:\\Windows\\x.dll' }, WIN, 'win32')).toBe('deny');
    expect(decide('Write', { file_path: 'src\\x.ts' }, WIN, 'win32')).toBe('allow');
  });

  it('denies editing git metadata (gitdir pointer, config, hooks) and agent settings', () => {
    // A redirected `.git` or a planted core.fsmonitor / hook would run code in the daemon's
    // own git calls; the worktree's git belongs to the daemon.
    expect(decide('Write', { file_path: '.git', content: 'gitdir: evil' })).toBe('deny');
    expect(decide('Edit', { file_path: '/work/ws/.git/config' })).toBe('deny');
    expect(decide('Write', { file_path: 'sub/.git/hooks/pre-commit' })).toBe('deny');
    expect(decide('Write', { file_path: '.GIT\\config' }, WIN, 'win32')).toBe('deny');
    expect(decide('Write', { file_path: '.git.\\config' }, WIN, 'win32')).toBe('deny');
    expect(decide('Write', { file_path: '.claude/settings.local.json', content: '{}' })).toBe(
      'deny',
    );
    expect(decide('Write', { file_path: '.gitignore', content: 'x' })).toBe('allow');
    expect(decide('Write', { file_path: 'docs/.github/x.md', content: 'x' })).toBe('allow');
    expect(decide('Read', { file_path: '.git/config' })).toBe('allow');
  });

  it('follows symlinks before deciding a path is inside the workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'acc-policy-'));
    try {
      const ws = join(root, 'ws');
      const outside = join(root, 'home');
      mkdirSync(ws);
      mkdirSync(outside);
      try {
        // A junction needs no privilege on Windows; a dir symlink elsewhere.
        symlinkSync(outside, join(ws, 'cfg'), process.platform === 'win32' ? 'junction' : 'dir');
      } catch {
        return; // the platform does not allow links here
      }
      const real = (toolName: string, input: unknown) =>
        // No temp-dir exception here: the test's own folders live in the temp dir.
        decideToolPermission({ toolName, input, cwd: ws, allowedOutside: [] }).decision;
      expect(real('Write', { file_path: join(ws, 'cfg', '.bashrc'), content: 'x' })).toBe('deny');
      expect(real('Read', { file_path: 'cfg/notes.txt' })).toBe('ask');
      expect(real('Read', { file_path: 'cfg/id_ed25519' })).toBe('deny');
      expect(real('Write', { file_path: 'new/dir/a.txt', content: 'x' })).toBe('allow');
      expect(realpathDeep(join(ws, 'cfg', 'missing', 'x'))).toBe(
        join(realpathDeep(outside), 'missing', 'x'),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('asks (careful) for commands, except allowlisted read-only Bash inside the workspace', () => {
    expect(decide('Bash', { command: 'pnpm test' })).toBe('ask');
    expect(decide('Bash', { command: 'git status && rm -rf build' })).toBe('ask');
    expect(decide('Bash', { command: 'git status && git diff' })).toBe('allow');
    expect(decide('Bash', { command: 'git status && rm -rf /' })).toBe('deny');
    expect(decide('Bash', {})).toBe('ask');
    expect(decide('PowerShell', { command: 'Get-ChildItem' })).toBe('ask');
    // Searching and looking around (commands.test.ts has the details).
    expect(decide('Bash', { command: 'ls' })).toBe('allow');
    expect(decide('Bash', { command: 'git status' })).toBe('allow');
    expect(decide('Bash', { command: "grep -rn 'TODO' src" })).toBe('allow');
    expect(decide('Bash', { command: 'cat ../other/secret' })).toBe('ask');
    expect(decide('Bash', { command: 'cat /etc/passwd' })).toBe('ask');
    expect(decide('Bash', { command: 'git -c core.quotepath=false status' })).toBe('ask');
    // Windows paths and case folding apply to command arguments too.
    expect(decide('Bash', { command: 'cat src/a.ts' }, WIN, 'win32')).toBe('allow');
    expect(decide('Bash', { command: 'cat C:/Users/me/.ssh/id_rsa' }, WIN, 'win32')).toBe('deny');
    expect(decide('Bash', { command: 'cat C:/Users/me/notes.txt' }, WIN, 'win32')).toBe('ask');
  });

  it('denies tools that do not fit an unattended run and allows the agent bookkeeping', () => {
    for (const t of [
      'AskUserQuestion',
      'EnterPlanMode',
      'EnterWorktree',
      'CronCreate',
      'Monitor',
    ]) {
      const r = decideToolPermission({ toolName: t, input: {}, cwd: POSIX, platform: 'linux' });
      expect(r.decision).toBe('deny');
      expect(r.rule).toBe('unattended');
      expect(r.message).toContain('Work autonomously');
    }
    for (const t of ['TaskCreate', 'TaskUpdate', 'TaskList', 'ToolSearch', 'Skill']) {
      expect(decide(t, {})).toBe('allow');
    }
    // Messaging other sessions and listing them are not bookkeeping.
    expect(decide('SendMessage', { to: 'x', message: 'y' })).toBe('ask');
    expect(decide('ListAgents', {})).toBe('ask');
  });

  it('asks for unknown, web and third-party MCP tools; allows control api tools', () => {
    expect(decide('WebFetch', { url: 'https://example.com' })).toBe('ask');
    expect(decide('SomethingNew', {})).toBe('ask');
    expect(decide('mcp__github__create_issue', {})).toBe('ask');
    expect(decide('mcp__acc__task_list', {})).toBe('allow');
    expect(decide('Task', { description: 'x', prompt: 'y' })).toBe('allow');
  });

  it('asks when the runtime flags a blocked path outside the workspace', () => {
    expect(
      decideToolPermission({
        toolName: 'Read',
        input: { file_path: 'src/a.ts' },
        cwd: POSIX,
        blockedPath: '/etc/hosts',
        platform: 'linux',
      }),
    ).toMatchObject({ decision: 'ask', reason: expect.stringContaining('/etc/hosts') });
  });
});

describe('tool descriptions', () => {
  it('describes activity in Japanese with workspace-relative paths', () => {
    const cwd = process.cwd();
    expect(describeToolActivity('Edit', { file_path: `${cwd}/src/x.ts` }, cwd)).toBe(
      'ファイルを編集中: src/x.ts',
    );
    expect(describeToolActivity('Bash', { command: 'pnpm test' }, cwd)).toBe(
      'コマンドを実行中: pnpm test',
    );
    expect(describeToolActivity('Grep', { pattern: 'TODO' }, cwd)).toBe('検索中: TODO');
    expect(describeToolActivity('Unknown', {}, cwd)).toBe('ツールを実行中: Unknown');
  });

  it('titles approvals', () => {
    expect(approvalTitleFor('Bash')).toBe('コマンドの実行を承認しますか');
    expect(approvalTitleFor('Write')).toBe('ファイルの変更を承認しますか');
    expect(approvalTitleFor('mcp__x__y')).toBe('ツール「mcp__x__y」の使用を承認しますか');
    expect(approvalDetailFor('Bash', { command: 'rm -rf build' }, process.cwd())).toBe(
      'rm -rf build',
    );
  });
});

describe('child env', () => {
  const parent: NodeJS.ProcessEnv = {
    Path: '/usr/bin',
    SystemRoot: 'C:\\Windows',
    USERPROFILE: 'C:\\Users\\me',
    TEMP: 'C:\\tmp',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    ACC_LITELLM_API_KEY: 'acc-secret',
    ANTHROPIC_API_KEY: 'sk-ant-user',
    GITHUB_TOKEN: 'ghp-secret',
  };

  it('copies only allowlisted variables, keeping their spelling', () => {
    const env = allowlistedEnv(parent);
    expect(env).toEqual({
      Path: '/usr/bin',
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\me',
      TEMP: 'C:\\tmp',
    });
  });

  it('inherits the user login when LiteLLM is not configured', () => {
    const routing = resolveModelRouting(Settings.parse({ defaultModel: 'gpt-4o' }), 'gpt-4o');
    expect(routing).toEqual({ kind: 'claude-login', model: null });
    const env = buildChildEnv(parent, routing, { clientApp: 'acc/test' });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-user');
    expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe('acc/test');
    expect(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1');
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
    expect(env).not.toHaveProperty('ACC_LITELLM_API_KEY');
    expect(resolveModelRouting(Settings.parse({}), 'claude-sonnet-4-5')).toEqual({
      kind: 'claude-login',
      model: 'claude-sonnet-4-5',
    });
  });

  it('routes to LiteLLM and replaces the user login', () => {
    const settings = Settings.parse({
      litellm: { baseUrl: 'http://127.0.0.1:4000/v1/', apiKey: 'sk-litellm' },
      defaultModel: 'claude-default',
    });
    const routing = resolveModelRouting(settings, null);
    expect(routing).toEqual({
      kind: 'litellm',
      baseUrl: 'http://127.0.0.1:4000',
      apiKey: 'sk-litellm',
      model: 'claude-default',
    });
    const env = buildChildEnv(parent, resolveModelRouting(settings, 'team-sonnet'));
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000',
      ANTHROPIC_AUTH_TOKEN: 'sk-litellm',
      ANTHROPIC_MODEL: 'team-sonnet',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'team-sonnet',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    // Logging uses names only.
    expect(envKeys(env).join(',')).not.toContain('sk-litellm');
  });

  it('normalizes base urls', () => {
    expect(normalizeAnthropicBaseUrl('https://llm.example.com/')).toBe('https://llm.example.com');
    expect(normalizeAnthropicBaseUrl('https://llm.example.com/v1')).toBe('https://llm.example.com');
  });
});
