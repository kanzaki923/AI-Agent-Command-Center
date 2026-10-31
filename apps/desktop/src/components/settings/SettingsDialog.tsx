import type { ParamsInput, PermissionProfile, SettingsView } from '@acc/protocol';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Monitor, Moon, ShieldAlert, ShieldCheck, Sun, Zap } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useStore } from 'zustand';
import { setDailyLimit } from '../../daemon/cost';
import { qk } from '../../daemon/keys';
import { useInfo, useModels, useSettings } from '../../daemon/queries';
import { useRuntime } from '../../daemon/runtime';
import { confirmShutdown } from '../../daemon/shutdown';
import { cn } from '../../lib/cn';
import { notificationPermission, requestNotificationPermission } from '../../lib/notify';
import { isTauri } from '../../lib/platform';
import { PROFILE_INFO } from '../../model/permissions';
import { toastError } from '../../store/toast';
import {
  type GlassScope,
  type GlassStrength,
  type MotionPref,
  type SettingsTab,
  type ThemePref,
  useUi,
} from '../../store/ui';
import { Button } from '../ui/Button';
import { Dialog, inputClass } from '../ui/Dialog';
import { FieldRow, type SegmentOption, Segmented, Stepper, UsdField } from './controls';
import { ModelRosterPanel, rosterSummary } from './ModelRoster';
import { ProviderPanel } from './ProviderPanel';
import { UsageStatsPanel } from './UsageStats';

type SettingsPatch = ParamsInput<'settings.update'>;

const icon = (I: typeof Zap) => <I size={13} strokeWidth={1.75} />;

/** 任せ方: the default permission profile, one icon and word each, one line on hover. */
export const PROFILE_OPTIONS: SegmentOption<PermissionProfile>[] = [
  {
    value: 'autonomous',
    label: PROFILE_INFO.autonomous.label,
    icon: icon(Zap),
    hint: '危険な操作だけ止めて、ほかは確認なしで進める',
  },
  {
    value: 'standard',
    label: PROFILE_INFO.standard.label,
    icon: icon(ShieldCheck),
    hint: '依存の追加と作業場所の外の読み取りは確認する',
  },
  {
    value: 'careful',
    label: PROFILE_INFO.careful.label,
    icon: icon(ShieldAlert),
    hint: '読み取りと編集のほかはすべて確認する',
  },
];

const THEME_OPTIONS: SegmentOption<ThemePref>[] = [
  { value: 'dark', label: 'ダーク', icon: icon(Moon), iconOnly: true },
  { value: 'light', label: 'ライト', icon: icon(Sun), iconOnly: true },
  { value: 'system', label: 'システムに合わせる', icon: icon(Monitor), iconOnly: true },
];

const MOTION_OPTIONS: SegmentOption<MotionPref>[] = [
  { value: 'system', label: '自動', hint: 'システムの設定に合わせる' },
  { value: 'on', label: '減らす' },
  { value: 'off', label: '減らさない' },
];

const ON_OFF: SegmentOption<'on' | 'off'>[] = [
  { value: 'on', label: 'オン' },
  { value: 'off', label: 'オフ' },
];

/** Off and the scope are one choice: where the desktop shows through, if at all. */
type GlassChoice = 'off' | GlassScope;
const GLASS_OPTIONS: SegmentOption<GlassChoice>[] = [
  { value: 'off', label: 'なし' },
  { value: 'wings', label: '翼だけ' },
  { value: 'all', label: '全体' },
];

const GLASS_STRENGTH_OPTIONS: SegmentOption<GlassStrength>[] = [
  { value: 'weak', label: '弱' },
  { value: 'mid', label: '中' },
  { value: 'strong', label: '強' },
];

type Judge = 'server' | 'client';
const JUDGE_OPTIONS: SegmentOption<Judge>[] = [
  { value: 'server', label: 'サーバー', hint: '追加の費用なし' },
  { value: 'client', label: '手元', hint: '1 回約 $0.01' },
];

/**
 * Where the models come from, in one line: the LiteLLM host with its model count, then the
 * other providers that are set up (Anthropic, OpenAI, ChatGPT with its account), or モック.
 */
export function connectionStatus(
  settings: SettingsView | undefined,
  models: { models: unknown[]; source: string } | undefined,
  failed: boolean,
): { tone: 'ok' | 'off' | 'error'; text: string } {
  const parts: string[] = [];
  let tone: 'ok' | 'off' | 'error' = 'ok';
  const url = settings?.litellm.baseUrl;
  if (url) {
    const host = url.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    const n = models?.source === 'litellm' ? models.models.length : 0;
    if (failed || n === 0) tone = 'error';
    parts.push(n > 0 ? `${host} · ${n} モデル` : host);
  }
  const p = settings?.providers;
  if (p?.anthropic.hasApiKey) parts.push('Anthropic');
  if (p?.openai.hasApiKey) parts.push('OpenAI');
  // The account itself stays off the summary: screens get shared and streamed.
  if (p?.openai.chatgpt) parts.push('ChatGPT');
  if (parts.length === 0) return { tone: 'off', text: 'モック' };
  return { tone, text: parts.join(' · ') };
}

const DOT = { ok: 'bg-st-done', off: 'bg-st-idle', error: 'bg-st-failed' } as const;

const TABS: readonly { value: SettingsTab; label: string }[] = [
  { value: 'general', label: '一般' },
  { value: 'usage', label: '利用統計' },
];

function Group({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-col gap-1.5 py-3', className)}>{children}</div>;
}

/**
 * Settings (spec §7): only what people change up front — the LLM connection, how much to leave
 * to the agents, the daily limit and the appearance. Everything else is folded under 詳細.
 * No explanation paragraphs; a name says what a row is, a tooltip adds one line where needed.
 */
export function SettingsDialog() {
  const rt = useRuntime();
  const open = useUi((s) => s.settingsOpen);
  const setOpen = useUi((s) => s.setSettingsOpen);
  const tab = useUi((s) => s.settingsTab);
  const setTab = useUi((s) => s.setSettingsTab);
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const reduceMotion = useUi((s) => s.reduceMotion);
  const setReduceMotion = useUi((s) => s.setReduceMotion);
  const glass = useUi((s) => s.glass);
  const setGlass = useUi((s) => s.setGlass);
  const glassScope = useUi((s) => s.glassScope);
  const setGlassScope = useUi((s) => s.setGlassScope);
  const glassStrength = useUi((s) => s.glassStrength);
  const setGlassStrength = useUi((s) => s.setGlassStrength);
  const settings = useSettings().data;
  const models = useModels();
  const [editing, setEditing] = useState(false);
  const [editingModels, setEditingModels] = useState(false);
  const [more, setMore] = useState(false);

  const update = (patch: SettingsPatch) => {
    rt.client
      .call('settings.update', patch)
      .then((v) => rt.queryClient.setQueryData(qk.settings, v))
      .catch((err: unknown) => toastError(err, '設定を保存できませんでした'));
  };
  const status = connectionStatus(settings, models.data, models.isError);
  const profile = settings?.defaultPermissionProfile;
  const daily = settings?.limits?.dailyUsd ?? null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setEditing(false);
          setEditingModels(false);
        }
      }}
      title="設定"
      className={editingModels || tab === 'usage' ? 'w-[640px]' : 'w-[520px]'}
    >
      <div role="tablist" aria-label="設定の画面" className="-mt-1 mb-1 flex gap-4 border-b border-line-subtle">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={tab === t.value}
            onClick={() => setTab(t.value)}
            className={cn(
              '-mb-px h-8 border-b-2 text-ui',
              tab === t.value ? 'border-accent text-fg' : 'border-transparent text-fg-3 hover:text-fg-2',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'usage' ? (
        <UsageStatsPanel />
      ) : (
        <>
      <Group className="pt-0">
        <FieldRow label="接続">
          <span
            className="flex min-w-0 items-center gap-2 text-ui text-fg-2"
            data-testid="connection-status"
          >
            <span className={cn('size-2 shrink-0 rounded-full', DOT[status.tone])} aria-hidden />
            <span className="truncate font-mono text-meta">{status.text}</span>
          </span>
          {!editing && (
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              変更
            </Button>
          )}
        </FieldRow>
        {editing && (
          <div className="mt-1 mb-2 rounded-md border border-line-subtle bg-canvas px-3 py-2">
            <ProviderPanel />
          </div>
        )}
        <FieldRow label="モデル" hint="上から順に、最初に当てはまったものを使います">
          <span className="truncate font-mono text-meta text-fg-2" data-testid="roster-summary">
            {rosterSummary(settings)}
          </span>
          {!editingModels && (
            <Button
              size="sm"
              variant="secondary"
              aria-label="モデルを変更"
              onClick={() => setEditingModels(true)}
            >
              変更
            </Button>
          )}
        </FieldRow>
        {editingModels && (
          <div className="mt-1 mb-2 rounded-md border border-line-subtle bg-canvas px-3 py-2">
            <ModelRosterPanel settings={settings} onSave={update} />
          </div>
        )}
        {profile && (
          <FieldRow label="任せ方">
            <Segmented<PermissionProfile>
              label="任せ方"
              value={profile}
              options={PROFILE_OPTIONS}
              onChange={(v) => update({ defaultPermissionProfile: v })}
            />
          </FieldRow>
        )}
        <FieldRow label="1 日の上限" htmlFor="daily-limit">
          <UsdField
            id="daily-limit"
            label="1 日の上限"
            value={daily}
            allowEmpty
            placeholder="—"
            onCommit={(v) => void setDailyLimit(rt, v)}
          />
        </FieldRow>
        {settings?.assistant && (
          <FieldRow
            label="右腕の上限"
            hint="右腕自身のモデル費用。1 日あたり"
            htmlFor="assistant-limit"
          >
            <UsdField
              id="assistant-limit"
              label="右腕の上限"
              value={settings.assistant.dailyUsd}
              allowEmpty
              allowZero
              placeholder="—"
              onCommit={(v) => update({ assistant: { dailyUsd: v } })}
            />
          </FieldRow>
        )}
        <FieldRow label="テーマ">
          <Segmented<ThemePref>
            label="テーマ"
            value={theme}
            options={THEME_OPTIONS}
            onChange={setTheme}
          />
        </FieldRow>
        <FieldRow label="動き">
          <Segmented<MotionPref>
            label="動きを減らす"
            value={reduceMotion}
            options={MOTION_OPTIONS}
            onChange={setReduceMotion}
          />
        </FieldRow>
        {isTauri() && (
          <FieldRow label="透け">
            <Segmented<GlassChoice>
              label="透け"
              value={glass === 'off' ? 'off' : glassScope}
              options={GLASS_OPTIONS}
              onChange={(v) => {
                if (v === 'off') setGlass('off');
                else {
                  setGlassScope(v);
                  setGlass('on');
                }
              }}
            />
            {glass === 'on' && (
              <Segmented<GlassStrength>
                label="透けの強さ"
                value={glassStrength}
                options={GLASS_STRENGTH_OPTIONS}
                onChange={setGlassStrength}
              />
            )}
          </FieldRow>
        )}
      </Group>
      <div className="border-t border-line-subtle">
        <button
          type="button"
          aria-expanded={more}
          onClick={() => setMore((m) => !m)}
          className="flex h-9 w-full items-center gap-1.5 text-ui text-fg-3 hover:text-fg-2"
        >
          <ChevronRight
            size={14}
            strokeWidth={1.75}
            className={cn('transition-transform duration-[120ms]', more && 'rotate-90')}
          />
          詳細
        </button>
        {more && <Details settings={settings} update={update} />}
      </div>
        </>
      )}
    </Dialog>
  );
}

function Details({
  settings,
  update,
}: {
  settings: SettingsView | undefined;
  update: (patch: SettingsPatch) => void;
}) {
  const rt = useRuntime();
  const info = useInfo();
  const unimplemented = useStore(rt.unimplemented, (s) => s.methods);
  const notifyOs = useUi((s) => s.notifyOs);
  const notifyInApp = useUi((s) => s.notifyInApp);
  const setNotify = useUi((s) => s.setNotify);
  const setShortcutsOpen = useUi((s) => s.setShortcutsOpen);
  const permission = useQuery({
    queryKey: ['notify.permission'],
    queryFn: notificationPermission,
    staleTime: 0,
  });
  const perm = permission.data ?? 'default';
  const autoMode = settings?.autoMode;
  const agents = settings?.maxConcurrentAgents ?? settings?.maxConcurrentRuns ?? 10;
  const chats = settings?.maxConcurrentChats;
  const reserve = settings?.llmCallReserveUsd;
  const autoResume = settings?.autoResume ?? settings?.autoResumeOrchestrators ?? true;
  const restart = isTauri();
  const askPermission = async () => {
    await requestNotificationPermission();
    await permission.refetch();
  };

  return (
    <div className="flex flex-col pb-1" data-testid="settings-details">
      {autoMode && (
        <Group className="pt-0">
          <FieldRow label="自動判定" hint="Claude Code の Auto mode">
            <Segmented<'on' | 'off'>
              label="自動判定"
              value={autoMode.enabled ? 'on' : 'off'}
              options={ON_OFF}
              onChange={(v) => update({ autoMode: { enabled: v === 'on' } })}
            />
          </FieldRow>
          {autoMode.enabled && autoMode.judge && (
            <FieldRow label="判定する場所">
              <Segmented<Judge>
                label="判定する場所"
                value={autoMode.judge}
                options={JUDGE_OPTIONS}
                onChange={(v) => update({ autoMode: { judge: v } })}
              />
            </FieldRow>
          )}
          {autoMode.enabled && (
            <FieldRow label="判定モデル" htmlFor="classifier-model">
              <input
                id="classifier-model"
                className={cn(inputClass, 'h-7 w-56 font-mono text-meta')}
                defaultValue={autoMode.classifierModel ?? ''}
                key={`classifier-${autoMode.classifierModel ?? ''}`}
                placeholder="既定"
                spellCheck={false}
                onBlur={(e) => {
                  const v = e.target.value.trim() || null;
                  if (v !== autoMode.classifierModel) update({ autoMode: { classifierModel: v } });
                }}
              />
            </FieldRow>
          )}
        </Group>
      )}
      <Group className="border-t border-line-subtle">
        <FieldRow label="同時に動くエージェント">
          <Stepper
            label="同時に動くエージェント"
            value={agents}
            min={1}
            max={64}
            onChange={(v) =>
              update(
                settings?.maxConcurrentAgents != null
                  ? { maxConcurrentAgents: v }
                  : { maxConcurrentRuns: v },
              )
            }
          />
        </FieldRow>
        {chats != null && (
          <FieldRow label="同時に動く会話">
            <Stepper
              label="同時に動く会話"
              value={chats}
              min={1}
              max={64}
              onChange={(v) => update({ maxConcurrentChats: v })}
            />
          </FieldRow>
        )}
        {reserve != null && (
          <FieldRow
            label="1 回の呼び出しの予約"
            htmlFor="llm-reserve"
            hint="呼び出しの前に予算から確保する額"
          >
            <UsdField
              id="llm-reserve"
              label="1 回の呼び出しの予約"
              value={reserve}
              max={100}
              allowZero
              onCommit={(v) => v != null && update({ llmCallReserveUsd: v })}
            />
          </FieldRow>
        )}
        <FieldRow label="再起動のあと再開">
          <Segmented<'on' | 'off'>
            label="再起動のあと再開"
            value={autoResume ? 'on' : 'off'}
            options={ON_OFF}
            onChange={(v) =>
              update(
                settings?.autoResume != null
                  ? { autoResume: v === 'on' }
                  : { autoResumeOrchestrators: v === 'on' },
              )
            }
          />
        </FieldRow>
      </Group>
      <Group className="border-t border-line-subtle">
        <FieldRow label="OS の通知">
          {notifyOs && perm === 'default' && (
            <Button size="sm" variant="ghost" onClick={() => void askPermission()}>
              許可する
            </Button>
          )}
          {notifyOs && (perm === 'denied' || perm === 'unsupported') && (
            <span className="text-meta text-st-failed" data-testid="notify-permission">
              {perm === 'denied' ? 'ブロック中' : '使えません'}
            </span>
          )}
          <Segmented<'on' | 'off'>
            label="OS の通知"
            value={notifyOs ? 'on' : 'off'}
            options={ON_OFF}
            onChange={(v) => {
              setNotify({ os: v === 'on' });
              if (v === 'on' && perm === 'default') void askPermission();
            }}
          />
        </FieldRow>
        <FieldRow label="アプリ内の通知">
          <Segmented<'on' | 'off'>
            label="アプリ内の通知"
            value={notifyInApp ? 'on' : 'off'}
            options={ON_OFF}
            onChange={(v) => setNotify({ inApp: v === 'on' })}
          />
        </FieldRow>
        <FieldRow label="ショートカット">
          <Button
            size="sm"
            variant="secondary"
            shortcutKeys="?"
            onClick={() => setShortcutsOpen(true)}
          >
            一覧
          </Button>
        </FieldRow>
      </Group>
      <Group className="border-t border-line-subtle">
        <FieldRow label="診断">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void confirmShutdown(rt)}
            data-testid="shutdown-daemon"
          >
            {restart ? 'Core Daemon を再起動' : 'Core Daemon を停止'}
          </Button>
        </FieldRow>
        {info.data && (
          <dl
            className="grid grid-cols-[72px_1fr] gap-x-3 gap-y-1 text-meta"
            data-testid="diagnostics"
          >
            <dt className="text-fg-3">バージョン</dt>
            <dd className="text-fg-2">{info.data.version}</dd>
            <dt className="text-fg-3">データ</dt>
            <dd className="font-mono break-all text-fg-2">{info.data.dataDir}</dd>
            <dt className="text-fg-3">プロセス</dt>
            <dd className="text-fg-2 tabular">
              pid {info.data.pid} · ポート {info.data.port}
            </dd>
            <dt className="text-fg-3">API</dt>
            <dd className="text-fg-2">
              {info.data.methods.length}
              {unimplemented.length > 0 && (
                <span className="text-fg-3"> · 未実装 {unimplemented.join(', ')}</span>
              )}
            </dd>
          </dl>
        )}
      </Group>
    </div>
  );
}
