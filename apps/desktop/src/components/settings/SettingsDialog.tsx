import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useStore } from 'zustand';
import { qk } from '../../daemon/keys';
import { useInfo, useSettings } from '../../daemon/queries';
import { useRuntime } from '../../daemon/runtime';
import { cn } from '../../lib/cn';
import {
  type NotifyPermission,
  notificationPermission,
  requestNotificationPermission,
} from '../../lib/notify';
import { useIsDemo } from '../../model/useDemo';
import { useConfirm } from '../../store/confirm';
import { toastError } from '../../store/toast';
import { Button } from '../ui/Button';
import { type MotionPref, type ThemePref, useUi } from '../../store/ui';
import { Dialog, FieldLabel, inputClass } from '../ui/Dialog';
import { LiteLlmForm } from './LiteLlmForm';

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex shrink-0 rounded-sm border border-line p-0.5 whitespace-nowrap">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'h-6 rounded-xs px-2.5 text-ui',
            value === o.value ? 'bg-selected text-fg' : 'text-fg-3 hover:text-fg-2',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-line-subtle py-4 first:border-t-0 first:pt-1">
      <h3 className="mb-3 text-micro text-fg-3">{title}</h3>
      {children}
    </section>
  );
}

const PERMISSION_TEXT: Record<NotifyPermission, string> = {
  granted: 'OS の通知は許可されています',
  default: 'OS の通知はまだ許可されていません',
  denied: 'OS の通知はブロックされています。OS（またはブラウザ）の設定で許可してください',
  unsupported: 'この環境では OS の通知を使えません',
};

/**
 * Attention notifications (§8.5): OS notifications while the window is in the background,
 * in-app toasts for what happens outside the current view. Asking the OS for permission
 * happens only here, from the person's own click.
 */
function NotificationSettings() {
  const notifyOs = useUi((s) => s.notifyOs);
  const notifyInApp = useUi((s) => s.notifyInApp);
  const setNotify = useUi((s) => s.setNotify);
  const permission = useQuery({ queryKey: ['notify.permission'], queryFn: notificationPermission, staleTime: 0 });
  const perm = permission.data ?? 'default';
  const ask = async () => {
    await requestNotificationPermission();
    await permission.refetch();
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-ui text-fg">OS の通知</div>
          <div className="text-meta text-fg-3">
            ウィンドウが裏にあるとき、承認待ち・失敗・統合の準備完了・Orchestrator の報告を知らせます。10 秒以内の同種はまとめます。
          </div>
        </div>
        <Segmented<'on' | 'off'>
          label="OS の通知"
          value={notifyOs ? 'on' : 'off'}
          onChange={(v) => {
            setNotify({ os: v === 'on' });
            if (v === 'on' && perm === 'default') void ask();
          }}
          options={[
            { value: 'on', label: 'オン' },
            { value: 'off', label: 'オフ' },
          ]}
        />
      </div>
      {notifyOs && (
        <div className="-mt-1 flex items-center gap-2 text-meta text-fg-3" data-testid="notify-permission">
          <span className={perm === 'granted' ? 'text-st-completed' : perm === 'denied' ? 'text-st-failed' : undefined}>
            {PERMISSION_TEXT[perm]}
          </span>
          {perm === 'default' && (
            <button type="button" className="text-accent hover:underline" onClick={() => void ask()}>
              許可する
            </button>
          )}
        </div>
      )}
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-ui text-fg">アプリ内の通知</div>
          <div className="text-meta text-fg-3">見ていない場所で起きたことを、右下に 1 件ずつ知らせます。</div>
        </div>
        <Segmented<'on' | 'off'>
          label="アプリ内の通知"
          value={notifyInApp ? 'on' : 'off'}
          onChange={(v) => setNotify({ inApp: v === 'on' })}
          options={[
            { value: 'on', label: 'オン' },
            { value: 'off', label: 'オフ' },
          ]}
        />
      </div>
    </div>
  );
}

export function SettingsDialog() {
  const rt = useRuntime();
  const open = useUi((s) => s.settingsOpen);
  const setOpen = useUi((s) => s.setSettingsOpen);
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const reduceMotion = useUi((s) => s.reduceMotion);
  const setReduceMotion = useUi((s) => s.setReduceMotion);
  const settings = useSettings().data;
  const info = useInfo();
  const demo = useIsDemo();
  const unimplemented = useStore(rt.unimplemented, (s) => s.methods);

  const updateNumber = (key: 'maxConcurrentRuns' | 'maxDelegationDepth', value: number) => {
    rt.client
      .call('settings.update', { [key]: value })
      .then((v) => rt.queryClient.setQueryData(qk.settings, v))
      .catch((err: unknown) => toastError(err, '設定を保存できませんでした'));
  };

  return (
    <Dialog open={open} onOpenChange={setOpen} title="設定" className="w-[600px]">
      <Section title="LLM の接続">
        <p className="mb-3 text-ui text-fg-3">
          {demo ? '現在はデモモード（組み込みの模擬モデル）です。LiteLLM Proxy を設定すると実際のモデルを使えます。' : 'LiteLLM Proxy 経由でモデルに接続しています。'}
        </p>
        <LiteLlmForm compact />
      </Section>
      <Section title="表示">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-ui text-fg">テーマ</span>
            <Segmented<ThemePref>
              label="テーマ"
              value={theme}
              onChange={setTheme}
              options={[
                { value: 'dark', label: 'ダーク' },
                { value: 'light', label: 'ライト' },
                { value: 'system', label: 'システムに合わせる' },
              ]}
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-ui text-fg">動きを減らす</span>
            <Segmented<MotionPref>
              label="動きを減らす"
              value={reduceMotion}
              onChange={setReduceMotion}
              options={[
                { value: 'system', label: 'システムに合わせる' },
                { value: 'on', label: 'オン' },
                { value: 'off', label: 'オフ' },
              ]}
            />
          </div>
        </div>
      </Section>
      <Section title="通知">
        <NotificationSettings />
      </Section>
      <Section title="実行の制約">
        <p className="mb-3 text-meta text-fg-3">Core Daemon が強制します。LLM への指示ではありません。</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel htmlFor="max-runs">同時実行の上限</FieldLabel>
            <input
              id="max-runs"
              type="number"
              min={1}
              max={64}
              className={inputClass}
              defaultValue={settings?.maxConcurrentRuns ?? 10}
              key={`runs-${settings?.maxConcurrentRuns}`}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (Number.isInteger(v) && v >= 1 && v <= 64 && v !== settings?.maxConcurrentRuns) updateNumber('maxConcurrentRuns', v);
              }}
            />
          </div>
          <div>
            <FieldLabel htmlFor="max-depth">委譲の深さ</FieldLabel>
            <input
              id="max-depth"
              type="number"
              min={0}
              max={4}
              className={inputClass}
              defaultValue={settings?.maxDelegationDepth ?? 1}
              key={`depth-${settings?.maxDelegationDepth}`}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (Number.isInteger(v) && v >= 0 && v <= 4 && v !== settings?.maxDelegationDepth) updateNumber('maxDelegationDepth', v);
              }}
            />
          </div>
        </div>
      </Section>
      <Section title="Core Daemon">
        {info.data ? (
          <dl className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-1 text-ui">
            <dt className="text-fg-3">バージョン</dt>
            <dd className="text-fg-2">{info.data.version}</dd>
            <dt className="text-fg-3">データ</dt>
            <dd className="font-mono text-meta break-all text-fg-2">{info.data.dataDir}</dd>
            <dt className="text-fg-3">プロセス</dt>
            <dd className="text-fg-2 tabular">
              pid {info.data.pid} · ポート {info.data.port}
            </dd>
            <dt className="text-fg-3">API</dt>
            <dd className="text-fg-2">
              {info.data.methods.length} メソッド実装済み
              {unimplemented.length > 0 && (
                <span className="text-fg-3">（未実装: {unimplemented.join(', ')}）</span>
              )}
            </dd>
          </dl>
        ) : (
          <p className="text-ui text-fg-3">接続を待っています…</p>
        )}
        {info.data?.methods.includes('system.shutdown') && (
          <div className="mt-3 flex items-center justify-between gap-4 border-t border-line-subtle pt-3">
            <span className="text-meta text-fg-3">
              Core Daemon は UI を閉じても動き続けます。止めると、動いているエージェントも停止します。
            </span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                useConfirm.getState().ask({
                  title: 'Core Daemon を停止しますか？',
                  body: '動いているエージェントと定期実行もすべて止まります。Run は「中断」として残り、あとで再開できます。',
                  confirmLabel: '停止する',
                  danger: true,
                  onConfirm: () => {
                    (rt.client.call as unknown as (m: string, p: unknown) => Promise<unknown>)('system.shutdown', {}).catch(
                      (err: unknown) => toastError(err, 'Core Daemon を停止できませんでした'),
                    );
                  },
                })
              }
            >
              Core Daemon を停止
            </Button>
          </div>
        )}
      </Section>
    </Dialog>
  );
}
