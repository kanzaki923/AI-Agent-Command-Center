/**
 * The tool loop's step-boundary injection, per-run turn limit and loop detection (spec
 * 20261029 §3.2), with a fake controller and gateway; and history repair around injected
 * messages (toChatMessages).
 */
import { EMPTY_USAGE, type Message } from '@acc/protocol';
import { describe, expect, it } from 'vitest';
import type { RunController } from '../contracts';
import type { DaemonContext } from '../core/context';
import type { LlmGateway } from './gateway';
import { toChatMessages } from './messages';
import { LOOP_REPEATS, RunStopError, runToolLoop } from './toolLoop';
import type { LoopTool } from './tools';
import type { ChatMessage, ChatRequest, ChatResult } from './types';

type Reply = { text?: string; calls?: { name: string; args?: unknown }[] };

function fakes(replies: (Reply | ((req: ChatRequest) => Reply))[]) {
  const requests: ChatRequest[] = [];
  let n = 0;
  let ids = 0;
  const gateway = {
    complete: (req: ChatRequest): Promise<ChatResult> => {
      requests.push({ ...req, messages: [...req.messages] });
      const step = replies[Math.min(n, replies.length - 1)]!;
      n += 1;
      const r = typeof step === 'function' ? step(req) : step;
      return Promise.resolve({
        text: r.text ?? '',
        reasoning: '',
        toolCalls: (r.calls ?? []).map((c) => ({
          id: `c${++ids}`,
          name: c.name,
          arguments: JSON.stringify(c.args ?? {}),
        })),
        thinkingBlocks: [],
        usage: EMPTY_USAGE,
        finishReason: null,
      });
    },
  } as unknown as LlmGateway;
  const appended: unknown[] = [];
  const ctl = {
    signal: new AbortController().signal,
    reserveBudget: () => ({ amountUsd: 0, settle: () => undefined, cancel: () => undefined }),
    setActivity: () => undefined,
    emitDelta: () => undefined,
    appendMessage: (m: unknown) => appended.push(m),
    toolCalled: () => undefined,
    toolResult: () => undefined,
  } as unknown as RunController;
  const ctx = { ids: { next: () => `msg_${++ids}` } } as unknown as DaemonContext;
  const tool = (name: string): LoopTool => ({
    name,
    description: name,
    parameters: { type: 'object' },
    execute: () => Promise.resolve({ ok: true }),
  });
  return { gateway, ctl, ctx, requests, appended, tool };
}

const user = (content: string): ChatMessage => ({ role: 'user', content });

describe('runToolLoop: injection at step boundaries', () => {
  it('hands messages that arrived to the next model call, after every tool result of the turn', async () => {
    const f = fakes([
      { text: '調べます', calls: [{ name: 'a' }, { name: 'b' }] },
      { text: 'わかりました' },
    ]);
    let pending: ChatMessage[] = [user('（作業中に届いた発言）\n追加')];
    const result = await runToolLoop({
      ctx: f.ctx,
      ctl: f.ctl,
      gateway: f.gateway,
      model: 'm',
      messages: [user('最初')],
      tools: [f.tool('a'), f.tool('b')],
      inject: () => pending.splice(0),
    });
    expect(result.stopReason).toBe('done');
    const roles = f.requests[1]!.messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool', 'tool', 'user']);
    expect(f.requests[1]!.messages.at(-1)).toEqual(user('（作業中に届いた発言）\n追加'));
    pending = [];
  });

  it('keeps going instead of ending when a message arrived just as the model answered', async () => {
    const f = fakes([{ text: '一つ目の答え' }, { text: '二つ目の答え' }]);
    const queue = [[user('もう一つ')], []];
    const result = await runToolLoop({
      ctx: f.ctx,
      ctl: f.ctl,
      gateway: f.gateway,
      model: 'm',
      messages: [user('質問')],
      inject: () => queue.shift() ?? [],
    });
    expect(result).toMatchObject({ stopReason: 'done', turns: 2, text: '二つ目の答え' });
    expect(f.requests[1]!.messages.at(-1)).toEqual(user('もう一つ'));
  });
});

describe('runToolLoop: daemon limits', () => {
  it('fails with turn_limit when failOnTurnLimit is set, and only returns max_turns otherwise', async () => {
    const replies = [
      { text: '1', calls: [{ name: 'a', args: { n: 1 } }] },
      { text: '2', calls: [{ name: 'a', args: { n: 2 } }] },
      { text: '3', calls: [{ name: 'a', args: { n: 3 } }] },
    ];
    const f = fakes(replies);
    await expect(
      runToolLoop({
        ctx: f.ctx,
        ctl: f.ctl,
        gateway: f.gateway,
        model: 'm',
        messages: [user('x')],
        tools: [f.tool('a')],
        maxTurns: 2,
        failOnTurnLimit: true,
      }),
    ).rejects.toMatchObject({ name: 'RunStopError', code: 'turn_limit' });
    const g = fakes(replies);
    const r = await runToolLoop({
      ctx: g.ctx,
      ctl: g.ctl,
      gateway: g.gateway,
      model: 'm',
      messages: [user('x')],
      tools: [g.tool('a')],
      maxTurns: 2,
    });
    expect(r.stopReason).toBe('max_turns');
  });

  it(`stops with loop_detected after the same tool calls ${LOOP_REPEATS} times in a row (argument order does not matter)`, async () => {
    let flip = false;
    const f = fakes([
      () => {
        flip = !flip;
        return { calls: [{ name: 'a', args: flip ? { x: 1, y: 2 } : { y: 2, x: 1 } }] };
      },
    ]);
    const err = await runToolLoop({
      ctx: f.ctx,
      ctl: f.ctl,
      gateway: f.gateway,
      model: 'm',
      messages: [user('x')],
      tools: [f.tool('a')],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunStopError);
    expect((err as RunStopError).code).toBe('loop_detected');
    expect(f.requests).toHaveLength(LOOP_REPEATS);
  });

  it('stops with loop_detected when the same text comes back three times, even with other tools', async () => {
    let n = 0;
    const f = fakes([() => ({ text: '同じ返事', calls: [{ name: 'a', args: { n: ++n } }] })]);
    await expect(
      runToolLoop({
        ctx: f.ctx,
        ctl: f.ctl,
        gateway: f.gateway,
        model: 'm',
        messages: [user('x')],
        tools: [f.tool('a')],
      }),
    ).rejects.toMatchObject({ code: 'loop_detected' });
    expect(n).toBe(3);
  });

  it('a different call in between breaks the streak; detectLoops: false turns it off', async () => {
    const seq = ['a', 'a', 'b', 'a', 'a'];
    let i = 0;
    const f = fakes([
      () => (i < seq.length ? { calls: [{ name: seq[i++]! }] } : { text: 'おわり' }),
    ]);
    const r = await runToolLoop({
      ctx: f.ctx,
      ctl: f.ctl,
      gateway: f.gateway,
      model: 'm',
      messages: [user('x')],
      tools: [f.tool('a'), f.tool('b')],
    });
    expect(r).toMatchObject({ stopReason: 'done', text: 'おわり' });
    const g = fakes([{ calls: [{ name: 'a' }] }]);
    const off = await runToolLoop({
      ctx: g.ctx,
      ctl: g.ctl,
      gateway: g.gateway,
      model: 'm',
      messages: [user('x')],
      tools: [g.tool('a')],
      detectLoops: false,
      maxTurns: 5,
    });
    expect(off.stopReason).toBe('max_turns');
  });
});

describe('toChatMessages around injected messages', () => {
  const base = {
    sessionId: 'ses_x',
    runId: null,
    author: { kind: 'human' as const, client: 't' },
    model: null,
    createdAt: '2026-10-29T00:00:00.000Z',
    delivery: 'delivered' as const,
    meta: null,
    usage: null,
  };
  let seq = 0;
  const msg = (role: Message['role'], content: Message['content']): Message => ({
    ...base,
    id: `msg_${String(++seq).padStart(4, '0')}`,
    role,
    content,
  });

  it('moves a message written while tool calls ran after their results', () => {
    const history = [
      msg('user', [{ type: 'text', text: '最初' }]),
      msg('assistant', [{ type: 'tool_call', toolCallId: 't1', name: 'session.get', input: {} }]),
      msg('user', [{ type: 'text', text: '途中の発言' }]),
      msg('tool', [{ type: 'tool_result', toolCallId: 't1', output: { ok: 1 }, isError: false }]),
      msg('assistant', [{ type: 'text', text: '答え' }]),
    ];
    expect(toChatMessages(history).map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'user',
      'assistant',
    ]);
  });

  it('still fills in a missing result (interrupted run) before the held message', () => {
    const history = [
      msg('assistant', [{ type: 'tool_call', toolCallId: 't9', name: 'session.get', input: {} }]),
      msg('user', [{ type: 'text', text: '続きは？' }]),
    ];
    const out = toChatMessages(history);
    expect(out.map((m) => m.role)).toEqual(['assistant', 'tool', 'user']);
    expect(out[1]).toMatchObject({ role: 'tool', toolCallId: 't9' });
  });
});
