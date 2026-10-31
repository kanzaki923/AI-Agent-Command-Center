import type { AgentActor, Settings } from '@acc/protocol';
import { Settings as SettingsSchema } from '@acc/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { DaemonContext } from '../core/context';
import { ApiError } from '../core/errors';
import { buildSupervisorPrompt } from '../orchestrator/executor';
import { HUMAN, type TestDaemonNoServer, agentActor, createTestDaemon } from '../testing';
import {
  agentCanUse,
  assertRosterModel,
  rosterModels,
  rosterPromptBlock,
  priceOf,
} from './roster';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const AGENT: AgentActor = { kind: 'agent', sessionId: 'ses_x', runId: 'run_x' };

function settings(over: Partial<Settings> = {}): Settings {
  return { ...SettingsSchema.parse({}), ...over };
}

function ctxWith(s: Settings): DaemonContext {
  return { settings: { get: () => s } } as unknown as DaemonContext;
}

function codeOf(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof ApiError ? err.code : 'other';
  }
}

const roster = settings({
  defaultModel: 'openai/gpt-6-luna',
  modelRules: [
    { model: 'anthropic/claude-opus-5-5', when: '画面設計で、Sonnet で一度うまくいかなかったとき' },
    { model: 'anthropic/claude-sonnet-5-5', when: '画面の設計・UI の実装' },
    { model: 'gemini-3-pro', when: '文章を書く・直す' },
  ],
});

describe('the model roster', () => {
  it('lists every row and the last one once', () => {
    expect(rosterModels(roster)).toEqual([
      'anthropic/claude-opus-5-5',
      'anthropic/claude-sonnet-5-5',
      'gemini-3-pro',
      'openai/gpt-6-luna',
    ]);
  });

  it('refuses a model an agent names outside the roster; people and the mocks are free', () => {
    const ctx = ctxWith(roster);
    expect(codeOf(() => assertRosterModel(ctx, AGENT, 'anthropic/claude-sonnet-5-5'))).toBeNull();
    expect(codeOf(() => assertRosterModel(ctx, AGENT, 'openai/gpt-6-astra'))).toBe(
      'invalid_params',
    );
    expect(codeOf(() => assertRosterModel(ctx, HUMAN, 'openai/gpt-6-astra'))).toBeNull();
    expect(codeOf(() => assertRosterModel(ctx, AGENT, 'mock/echo'))).toBeNull();
    // Nothing set yet: nothing to hold the agent to.
    expect(codeOf(() => assertRosterModel(ctxWith(settings()), AGENT, 'x'))).toBeNull();
  });

  it('keeps agents (Claude Code) to models they can run: Claude without LiteLLM, LiteLLM names with it', () => {
    expect(agentCanUse(roster, 'anthropic/claude-sonnet-5-5')).toBe(true);
    expect(agentCanUse(roster, 'openai/gpt-6-luna')).toBe(false);
    const ctx = ctxWith(roster);
    expect(
      codeOf(() => assertRosterModel(ctx, AGENT, 'openai/gpt-6-luna', { agentRuntime: true })),
    ).toBe('invalid_params');
    const behindLiteLlm = settings({
      ...roster,
      litellm: { baseUrl: 'http://127.0.0.1:4000', apiKey: null },
    });
    expect(agentCanUse(behindLiteLlm, 'gemini-3-pro')).toBe(true);
    expect(agentCanUse(behindLiteLlm, 'anthropic/claude-sonnet-5-5')).toBe(false);
  });

  it('prices per 1M tokens: a plan on a ChatGPT plan, null when unknown', () => {
    const pricing = (m: string) =>
      m.includes('sonnet')
        ? { inputPerMTok: 2, outputPerMTok: 10 }
        : { inputPerMTok: 99, outputPerMTok: 99, basis: 'fallback' };
    expect(priceOf(roster, 'anthropic/claude-sonnet-5-5', pricing)).toEqual({
      inputPerMTok: 2,
      outputPerMTok: 10,
    });
    expect(priceOf(roster, 'gemini-3-pro', pricing)).toBeNull();
    const plan = settings({
      ...roster,
      providers: {
        ...roster.providers,
        openai: {
          ...roster.providers.openai,
          chatgpt: {
            clientId: 'c',
            refreshToken: 'r',
            accessToken: null,
            expiresAt: null,
            email: null,
            sub: null,
          },
        },
      },
    });
    expect(priceOf(plan, 'openai/gpt-6-luna', pricing)).toBe('plan');
  });

  it('tells the supervisor the order, the cost and which rows an agent can use', () => {
    const pricing = (m: string) =>
      m.includes('sonnet') ? { inputPerMTok: 2, outputPerMTok: 10 } : null;
    const block = rosterPromptBlock(roster, pricing)!;
    expect(block).toContain('take the model of the first row whose "when" fits');
    expect(block).toContain(
      '2. anthropic/claude-sonnet-5-5 — when: 画面の設計・UI の実装 — $2 in / $10 out per 1M tokens; agent: yes',
    );
    expect(block).toContain('3. gemini-3-pro — when: 文章を書く・直す — price unknown; agent: no');
    expect(block).toContain('- Otherwise: openai/gpt-6-luna');
    const prompt = buildSupervisorPrompt({
      project: null,
      grant: null,
      maxModelCalls: 24,
      models: block,
    });
    expect(prompt).toContain(block);
    expect(rosterPromptBlock(settings(), null)).toBeNull();
  });
});

describe('the roster in the daemon', () => {
  async function daemon(): Promise<TestDaemonNoServer> {
    const d = await createTestDaemon();
    cleanups.push(() => d.cleanup());
    return d;
  }

  it('saves the roster in order and shows it in the settings', async () => {
    const d = await daemon();
    const view = await d.call(HUMAN, 'settings.update', {
      defaultModel: roster.defaultModel,
      modelRules: roster.modelRules.map((r) => ({ ...r, when: ` ${r.when} ` })),
    });
    expect(view.modelRules).toEqual(roster.modelRules);
    expect(d.ctx.settings.get().modelRules).toEqual(roster.modelRules);
  });

  it('refuses a child on a model outside the roster (session.spawn by a supervisor)', async () => {
    const d = await daemon();
    await d.call(HUMAN, 'settings.update', {
      defaultModel: roster.defaultModel,
      modelRules: roster.modelRules,
    });
    const sup = await d.call(HUMAN, 'session.create', { title: '指揮役' });
    d.ctx.service('policy').createGrant(
      {
        subject: { kind: 'session', sessionId: sup.id },
        permissions: ['session.spawn'],
        limits: { maxChildren: 4, maxDepth: 1 },
        lifetime: 'session',
        reason: 'supervisor',
      },
      HUMAN,
    );
    const actor = agentActor(sup.id, d.ctx.ids.next('run'));
    const spawn = (model: string) =>
      d.call(actor, 'session.spawn', {
        title: '画面',
        goal: '設定画面を作る',
        mode: 'chat',
        model,
        start: false,
      });
    await expect(spawn('openai/gpt-6-astra')).rejects.toMatchObject({ code: 'invalid_params' });
    const ok = await spawn('anthropic/claude-sonnet-5-5');
    expect(ok.session.model).toBe('anthropic/claude-sonnet-5-5');
  });
});
