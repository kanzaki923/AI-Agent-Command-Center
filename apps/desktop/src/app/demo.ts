import { AccClientError } from '@acc/client';
import type { ModelInfo, ParamsInput } from '@acc/protocol';
import { createSession, delegateSession } from '../daemon/actions';
import { isNotImplemented } from '../daemon/errors';
import { qk } from '../daemon/keys';
import type { AppRuntime } from '../daemon/runtime';
import { toastError } from '../store/toast';
import { useUi } from '../store/ui';

/** Title of the demo conversation (the daemon's system.setupDemo uses the same). */
export const DEMO_TITLE = 'デモ: 新製品ローンチ準備';

/** Mock models, best demo experience first (the scripted supervisor beats plain echo). */
const DEMO_MODEL_PREFERENCE = ['mock/orchestrator', 'mock/demo', 'mock/echo'];

export function pickDemoModel(models: readonly ModelInfo[]): string | null {
  for (const id of DEMO_MODEL_PREFERENCE) if (models.some((m) => m.id === id)) return id;
  return models.find((m) => m.id.startsWith('mock/'))?.id ?? null;
}

type Spawn = ParamsInput<'session.spawn'>;
type Step = Record<string, unknown>;

/** A child's request with the mock agent's script (an `acc-mock` block, never shown as is). */
function scripted(goal: string, steps: Step[], summary: string): string {
  return [goal, '', '```acc-mock', JSON.stringify({ steps, summary }, null, 2), '```'].join('\n');
}

const say = (text: string): Step => ({ type: 'say', text });

/**
 * The demo's three children: research that ends with a table, a FAQ that asks the human one
 * question first, and an announcement that takes a little longer. They run on the mock agent
 * runtime only, whatever the default runtime is, so the demo never costs anything.
 */
export const DEMO_CHILDREN: Omit<Spawn, 'parentSessionId'>[] = [
  {
    title: '競合の価格を調べる',
    goal: scripted(
      '競合 3 社の価格と主な機能を調べて、表にまとめてください。',
      [
        say('競合 3 社の公開情報を確認します。'),
        { type: 'sleep', ms: 8_000 },
        {
          type: 'publish',
          kind: 'data',
          title: '競合 3 社の価格',
          columns: ['会社', '月額', '主な機能'],
          rows: [
            ['A 社', '1,200 円', '家族共有・カレンダー連携'],
            ['B 社', '980 円', '買い物リスト'],
            ['C 社', '無料プランあり', '広告つき'],
          ],
        },
      ],
      '競合 3 社の価格を表にまとめました。',
    ),
    doneWhen: ['3 社の価格が表になっている'],
  },
  {
    title: 'FAQ を書く',
    goal: scripted(
      '問い合わせが多そうな質問 5 つと回答を FAQ にまとめてください。',
      [
        say('想定される質問を洗い出します。'),
        { type: 'write', path: 'faq.md', content: '# よくある質問\n\n## 始め方は？\nアプリを開いて家族を招待します。\n' },
        { type: 'ask', title: '価格（月額 980 円）を FAQ に載せますか？', choices: ['載せる', '発売時に案内'] },
        { type: 'append', path: 'faq.md', content: '\n## 料金は？\n月額 980 円です。\n' },
        { type: 'publish', kind: 'document', title: 'FAQ', path: 'faq.md' },
      ],
      'FAQ（5 問）をまとめました。',
    ),
    doneWhen: ['質問と回答が 5 組ある'],
  },
  {
    title: '告知文を書く',
    goal: scripted(
      '発表用の告知文（300 字程度）を書いてください。',
      [
        say('伝えたい点を 3 つに絞ります。'),
        { type: 'sleep', ms: 25_000 },
        {
          type: 'write',
          path: 'announcement.md',
          content: '# 家族の予定を、ひとつのノートに\n\n来月 1 日、家族向けの予定共有アプリを発売します。\n',
        },
        { type: 'publish', kind: 'document', title: '告知文', path: 'announcement.md' },
      ],
      '告知文を書きました。',
    ),
    doneWhen: ['300 字程度の告知文がある'],
  },
].map((c) => ({ ...c, mode: 'agent' as const, runtime: 'mock', workspace: { kind: 'none' as const } }));

const missing = (err: unknown) =>
  isNotImplemented(err) || (err instanceof AccClientError && err.code === 'not_found');

/**
 * The demo conversation, delegated: the daemon's own setup when it has one (a folder project,
 * the conversation on the mock supervisor, delegated, a weekly report), otherwise created
 * here and delegated with the defaults.
 */
async function demoConversation(rt: AppRuntime, methods: ReadonlySet<string> | null): Promise<string | null> {
  if (!methods || methods.has('system.setupDemo')) {
    try {
      const res = await rt.client.call('system.setupDemo', {});
      void rt.queryClient.invalidateQueries({ queryKey: qk.projects });
      return res.session.id;
    } catch (err) {
      if (!missing(err)) {
        toastError(err, 'デモを準備できませんでした');
        return null;
      }
    }
  }
  const models = await rt
    .callOr('models.list', {}, { models: [], source: 'config' })
    .catch(() => ({ models: [] as ModelInfo[] }));
  const s = await createSession(rt, { kind: 'chat', title: DEMO_TITLE, model: pickDemoModel(models.models) });
  if (!s) return null;
  return (await delegateSession(rt, s.id, { projectId: null })) ? s.id : null;
}

/**
 * あとで（モックで試す） (spec §7): a demo conversation, delegated, with three children working
 * on mock models (session.spawn). Running it again reuses the conversation and adds children
 * only while it has none. Lands on the home screen, where the tree shows them working.
 */
export async function startDemo(rt: AppRuntime, methods: ReadonlySet<string> | null): Promise<string | null> {
  const sessionId = await demoConversation(rt, methods);
  if (!sessionId) return null;
  const tree = await rt.client.call('session.tree', { sessionId }).catch(() => null);
  const hasChildren = !!tree?.nodes.some((n) => n.parentId === sessionId);
  if (!hasChildren) {
    for (const child of DEMO_CHILDREN) {
      try {
        await rt.client.call('session.spawn', { ...child, parentSessionId: sessionId });
      } catch (err) {
        toastError(err, 'デモのエージェントを起こせませんでした');
        break;
      }
    }
  }
  void rt.queryClient.invalidateQueries({ queryKey: qk.sessions });
  void rt.queryClient.invalidateQueries({ queryKey: qk.home });
  const ui = useUi.getState();
  ui.finishOnboarding();
  ui.goHome();
  return sessionId;
}
