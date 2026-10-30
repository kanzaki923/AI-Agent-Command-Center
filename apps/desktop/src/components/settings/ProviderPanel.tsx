import { openUrl } from '@tauri-apps/plugin-opener';
import type { ChatGptStatus } from '@acc/protocol';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { qk } from '../../daemon/keys';
import { useSettings } from '../../daemon/queries';
import { useRuntime } from '../../daemon/runtime';
import { isTauri } from '../../lib/platform';
import { toastError } from '../../store/toast';
import { Button } from '../ui/Button';
import { inputClass } from '../ui/Dialog';
import { LiteLlmForm } from './LiteLlmForm';
import { FieldRow } from './controls';

type Keyed = 'anthropic' | 'openai';

const KEYED: { id: Keyed; label: string; placeholder: string }[] = [
  { id: 'anthropic', label: 'Anthropic', placeholder: 'sk-ant-…' },
  { id: 'openai', label: 'OpenAI', placeholder: 'sk-…' },
];

/** The host of a URL, for a status line. */
export function hostOf(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

/**
 * Where the models come from (architecture.md §2.11): LiteLLM, Anthropic and OpenAI by key,
 * and a ChatGPT plan by sign-in, side by side. Each row is one connection: its state and one
 * action. Keys go to the Core Daemon only and come back masked.
 */
export function ProviderPanel() {
  const settings = useSettings().data;
  const [litellmOpen, setLitellmOpen] = useState(false);
  const litellm = settings?.litellm.baseUrl ? hostOf(settings.litellm.baseUrl) : null;
  return (
    <div className="flex flex-col gap-1.5" data-testid="provider-panel">
      <FieldRow label="LiteLLM">
        <span className="truncate font-mono text-meta text-fg-2">{litellm ?? '未設定'}</span>
        {!litellmOpen && (
          <Button size="sm" variant="secondary" onClick={() => setLitellmOpen(true)}>
            {litellm ? '変更' : '設定'}
          </Button>
        )}
      </FieldRow>
      {litellmOpen && (
        <div className="mb-1 rounded-md border border-line-subtle bg-canvas p-3">
          <LiteLlmForm
            compact
            onDone={() => setLitellmOpen(false)}
            onCancel={() => setLitellmOpen(false)}
          />
        </div>
      )}
      {settings?.providers &&
        KEYED.map((p) => <KeyRow key={p.id} {...p} view={settings.providers![p.id]} />)}
      {settings?.providers && <ChatGptRow signedIn={settings.providers.openai.chatgpt} />}
    </div>
  );
}

/** A key the daemon keeps: shown masked, replaced in place, or taken off. */
function KeyRow({
  id,
  label,
  placeholder,
  view,
}: {
  id: Keyed;
  label: string;
  placeholder: string;
  view: { hasApiKey: boolean; apiKeyMasked: string | null };
}) {
  const rt = useRuntime();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async (apiKey: string | null) => {
    setSaving(true);
    try {
      const v = await rt.client.call('settings.update', { providers: { [id]: { apiKey } } });
      rt.queryClient.setQueryData(qk.settings, v);
      void rt.queryClient.invalidateQueries({ queryKey: qk.models });
      setEditing(false);
      setValue('');
    } catch (err) {
      toastError(err, '保存できませんでした');
    } finally {
      setSaving(false);
    }
  };
  if (editing) {
    return (
      <FieldRow label={label} htmlFor={`${id}-key`}>
        <form
          className="flex min-w-0 flex-1 items-center justify-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) void save(value.trim());
          }}
        >
          <input
            id={`${id}-key`}
            type="password"
            autoFocus
            className={`${inputClass} max-w-64`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            autoComplete="off"
            aria-label={`${label} の API キー`}
          />
          <Button size="sm" variant="primary" type="submit" disabled={!value.trim() || saving}>
            保存
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(false)}>
            取り消し
          </Button>
        </form>
      </FieldRow>
    );
  }
  return (
    <FieldRow label={label}>
      <span className="truncate font-mono text-meta text-fg-2">
        {view.hasApiKey ? (view.apiKeyMasked ?? '••••') : '未設定'}
      </span>
      <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
        {view.hasApiKey ? '変更' : '設定'}
      </Button>
      {view.hasApiKey && (
        <Button size="sm" variant="ghost" disabled={saving} onClick={() => void save(null)}>
          外す
        </Button>
      )}
    </FieldRow>
  );
}

/** Open the authorization page: the OS browser in Tauri, a tab in the browser build. */
function openInBrowser(url: string): void {
  if (isTauri()) void openUrl(url).catch(() => window.open(url, '_blank', 'noopener,noreferrer'));
  else window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * "Sign in with ChatGPT": one button; while the browser side is open the row waits (the
 * daemon's status is polled), then the account shows with サインアウト.
 */
function ChatGptRow({ signedIn }: { signedIn: { email: string | null } | null }) {
  const rt = useRuntime();
  const [busy, setBusy] = useState(false);
  const status = useQuery<ChatGptStatus>({
    queryKey: qk.chatgptStatus,
    queryFn: () => rt.client.call('chatgpt.status', {}),
    refetchInterval: (q) => (q.state.data?.state === 'waiting' ? 1500 : false),
  });
  const state = status.data?.state ?? (signedIn ? 'signed_in' : 'signed_out');
  const email = signedIn?.email ?? status.data?.email ?? null;
  const refresh = () => {
    void rt.queryClient.invalidateQueries({ queryKey: qk.chatgptStatus });
    void rt.queryClient.invalidateQueries({ queryKey: qk.settings });
    void rt.queryClient.invalidateQueries({ queryKey: qk.models });
  };
  const signIn = async () => {
    setBusy(true);
    try {
      const { url } = await rt.client.call('chatgpt.signIn', {});
      openInBrowser(url);
      refresh();
    } catch (err) {
      toastError(err, 'サインインを始められませんでした');
    } finally {
      setBusy(false);
    }
  };
  const signOut = async () => {
    setBusy(true);
    try {
      await rt.client.call('chatgpt.signOut', {});
      refresh();
    } catch (err) {
      toastError(err, 'サインアウトできませんでした');
    } finally {
      setBusy(false);
    }
  };
  return (
    <FieldRow label="ChatGPT" hint="ChatGPT の契約の枠で OpenAI のモデルを使う（API の課金なし）">
      {state === 'signed_in' ? (
        <>
          <span className="truncate font-mono text-meta text-fg-2" data-testid="chatgpt-account">
            {email ?? 'サインイン済み'}
          </span>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void signOut()}>
            サインアウト
          </Button>
        </>
      ) : state === 'waiting' ? (
        <>
          <span className="flex items-center gap-1.5 text-meta text-fg-2">
            <Loader2 size={13} className="animate-spin" aria-hidden />
            ブラウザで続けてください
          </span>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void signOut()}>
            やめる
          </Button>
        </>
      ) : (
        <>
          {state === 'error' && status.data?.error && (
            <span className="truncate text-meta text-st-failed">{status.data.error}</span>
          )}
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void signIn()}>
            ChatGPT でサインイン
          </Button>
        </>
      )}
    </FieldRow>
  );
}
