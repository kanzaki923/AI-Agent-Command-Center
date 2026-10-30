// The assistant (右腕) against a real model: a daemon in a temp ACC_HOME, the API key handed
// to this process only (never printed), the assistant on the chosen model, every tree it
// starts on the mock supervisor. Writes a transcript (text, tool calls, status, cost).
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Actor, Message } from '@acc/protocol';
import { startDaemon } from '../src/daemon';
import { silentLogger } from '../src/core/log';

const MODEL = process.argv[2] ?? 'claude-haiku-5-5';
const OUT = process.argv[3] ?? join(process.cwd(), 'real-right-hand.txt');
const HUMAN: Actor = { kind: 'human', client: 'real-check' };
// Which provider the model names decides which key is needed: `anthropic/…` takes
// ACC_ANTHROPIC_API_KEY (the Messages API), `openai/…` ACC_OPENAI_API_KEY (the Responses
// API), anything else goes through ACC_LITELLM_BASE_URL / ACC_LITELLM_API_KEY (defaulting to
// the OpenAI-compatible endpoint of Anthropic, so no LiteLLM is needed for a Claude check).
const provider = MODEL.startsWith('anthropic/')
  ? 'anthropic'
  : MODEL.startsWith('openai/')
    ? 'openai'
    : 'litellm';
const key =
  provider === 'anthropic'
    ? process.env.ACC_ANTHROPIC_API_KEY
    : provider === 'openai'
      ? process.env.ACC_OPENAI_API_KEY
      : process.env.ACC_LITELLM_API_KEY;
const baseUrl = process.env.ACC_LITELLM_BASE_URL ?? 'https://api.anthropic.com/v1';
if (!key)
  throw new Error(`the key for ${provider} is not set (ACC_${provider.toUpperCase()}_API_KEY)`);

const home = mkdtempSync(join(tmpdir(), 'acc-real-'));
// Beside ACC_HOME: the data folder of the app cannot be a workspace.
const folder = `${home}-docs`;
mkdirSync(folder, { recursive: true });
writeFileSync(join(folder, 'README.md'), '# メモ\n\nとりあえず。\n');

const lines: string[] = [];
const log = (s: string) => {
  lines.push(s);
  console.log(s);
};

const daemon = await startDaemon({
  home,
  log: silentLogger,
  port: 0,
  env: provider === 'litellm' ? { ACC_LITELLM_BASE_URL: baseUrl, ACC_LITELLM_API_KEY: key } : {},
});
const call = daemon.call.bind(daemon);
try {
  await call(HUMAN, 'settings.update', {
    defaultRuntime: 'mock',
    defaultModel: 'mock/orchestrator',
    assistant: { model: MODEL, dailyUsd: 1 },
    limits: { dailyUsd: 1 },
    ...(provider === 'anthropic' ? { providers: { anthropic: { apiKey: key } } } : {}),
    ...(provider === 'openai' ? { providers: { openai: { apiKey: key } } } : {}),
  });
  const project = await call(HUMAN, 'project.create', { name: 'メモ帳', folderPath: folder });
  const { sessionId } = await call(HUMAN, 'system.assistant', {});
  log(`model=${MODEL} assistant=${sessionId}`);

  const textOf = (m: Message) =>
    m.content
      .map((p) =>
        p.type === 'text'
          ? p.text
          : p.type === 'tool_call'
            ? `  [call ${p.name} ${JSON.stringify(p.input)}]`
            : p.type === 'tool_result'
              ? `  [result ${p.name ?? ''} ${JSON.stringify(p.output).slice(0, 160)}]`
              : '',
      )
      .filter(Boolean)
      .join('\n');

  let seen = 0;
  const ask = async (content: string, hint?: string) => {
    log(`\n=== 人: ${content}${hint ? `   (hint: ${hint})` : ''}`);
    const t0 = Date.now();
    const r = await call(HUMAN, 'session.send', { sessionId, content, ...(hint ? { hint } : {}) });
    const run = await daemon.ctx.service('runs').waitForEnd(r.runId!);
    const msgs = (await call(HUMAN, 'session.messages', { sessionId, limit: 500 })).items;
    for (const m of msgs.slice(seen)) {
      if (m.role === 'user') continue;
      log(`${m.role === 'assistant' ? '右腕' : m.role}: ${textOf(m)}`);
    }
    seen = msgs.length;
    log(
      `-- ${run.status}${run.statusReason ? ` (${run.statusReason})` : ''} ${((Date.now() - t0) / 1000).toFixed(1)}s cost=$${run.usage.costUsd.toFixed(4)} (${run.usage.costSource}) in=${run.usage.inputTokens} out=${run.usage.outputTokens}${run.error ? ` error=${run.error.message}` : ''}`,
    );
    const home = await call(HUMAN, 'home.get', {});
    log(
      `   木: ${home.trees.map((t) => `「${t.root.title}」${t.root.state}/${t.root.startedBy}${t.nextRunAt ? ' ⟳' : ''}`).join(', ') || 'なし'}`,
    );
  };

  await ask('来月のローンチ準備を進めて。競合の価格、FAQ、告知文をお願い');
  await ask('今どう？');
  await ask('Excel で A 列の重複を消すには？');
  await ask(
    'このフォルダの README を整えて',
    `フォルダ ${folder} (プロジェクト「メモ帳」 projectId: ${project.id})`,
  );
  await ask('ローンチ準備は止めて');
  await ask('毎朝 9 時に昨日のまとめを作って');
  await ask('ローンチ準備を再開して。FAQ は 5 問でいい');

  const cost = await call(HUMAN, 'cost.summary', { range: 'today', groupBy: 'model' });
  log(
    `\n合計 $${cost.totalUsd.toFixed(4)} ${JSON.stringify(cost.rows.map((r) => [r.label, r.usd]))}`,
  );
} finally {
  writeFileSync(OUT, lines.join('\n'));
  await daemon.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
