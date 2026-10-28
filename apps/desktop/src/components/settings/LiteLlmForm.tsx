import { AccClientError } from '@acc/client';
import type { ModelInfo } from '@acc/protocol';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { isNotImplemented } from '../../daemon/errors';
import { qk } from '../../daemon/keys';
import { useSettings } from '../../daemon/queries';
import { useConnectionState, useRuntime } from '../../daemon/runtime';
import { Button } from '../ui/Button';
import { FieldLabel, inputClass } from '../ui/Dialog';

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; models: ModelInfo[] }
  | { kind: 'saved-no-models' }
  | { kind: 'error'; message: string; field: 'url' | 'key' | null };

/** Cause-specific, one-sentence failure messages (§8.1). */
export function classifyConnectionError(err: unknown): { message: string; field: 'url' | 'key' | null } {
  const text = err instanceof Error ? err.message : String(err);
  if (err instanceof AccClientError && err.code === 'invalid_params') {
    return { message: 'URL の形式が正しくありません', field: 'url' };
  }
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|auth|api key|invalid.*key/i.test(text)) {
    return { message: '認証に失敗しました。API キーを確認してください', field: 'key' };
  }
  return { message: '接続できませんでした。URL とネットワークを確認してください', field: 'url' };
}

/**
 * LiteLLM Proxy connection (onboarding + settings). The key goes to the Core Daemon only;
 * the UI never keeps it (§8.1) — the field is cleared after saving.
 */
export function LiteLlmForm({ onDone, compact = false }: { onDone?: () => void; compact?: boolean }) {
  const rt = useRuntime();
  const settings = useSettings().data;
  const connected = useConnectionState() === 'open';
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [state, setState] = useState<TestState>({ kind: 'idle' });
  const [model, setModel] = useState<string | null>(null);
  const url = baseUrl ?? settings?.litellm.baseUrl ?? '';

  const test = async () => {
    const trimmed = url.trim();
    if (!/^https?:\/\/\S+$/i.test(trimmed)) {
      setState({ kind: 'error', message: 'URL の形式が正しくありません', field: 'url' });
      return;
    }
    setState({ kind: 'testing' });
    try {
      await rt.client.call('settings.update', {
        litellm: { baseUrl: trimmed, ...(apiKey ? { apiKey } : {}) },
      });
      setApiKey('');
      void rt.queryClient.invalidateQueries({ queryKey: qk.settings });
      try {
        const res = await rt.client.call('models.list', { refresh: true });
        rt.queryClient.setQueryData(qk.models, res);
        if (res.models.length === 0) throw new Error('no models');
        setState({ kind: 'ok', models: res.models });
        setModel(settings?.defaultModel ?? res.models[0]?.id ?? null);
      } catch (err) {
        if (isNotImplemented(err)) setState({ kind: 'saved-no-models' });
        else setState({ kind: 'error', ...classifyConnectionError(err) });
      }
    } catch (err) {
      setState({ kind: 'error', ...classifyConnectionError(err) });
    }
  };

  const finish = async () => {
    if (state.kind === 'ok' && model) {
      try {
        await rt.client.call('settings.update', { defaultModel: model });
        void rt.queryClient.invalidateQueries({ queryKey: qk.settings });
      } catch (err) {
        setState({ kind: 'error', ...classifyConnectionError(err) });
        return;
      }
    }
    onDone?.();
  };

  const err = state.kind === 'error' ? state : null;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void (state.kind === 'ok' || state.kind === 'saved-no-models' ? finish() : test());
      }}
    >
      <div>
        <FieldLabel htmlFor="litellm-url">Proxy の URL</FieldLabel>
        <input
          id="litellm-url"
          autoFocus={!compact}
          className={inputClass}
          value={url}
          onChange={(e) => {
            setBaseUrl(e.target.value);
            setState({ kind: 'idle' });
          }}
          placeholder="http://localhost:4000"
          autoComplete="off"
          spellCheck={false}
        />
        {err?.field === 'url' && <p className="mt-1 text-meta text-st-failed">{err.message}</p>}
      </div>
      <div>
        <FieldLabel htmlFor="litellm-key">API キー</FieldLabel>
        <input
          id="litellm-key"
          type="password"
          className={inputClass}
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value);
            setState({ kind: 'idle' });
          }}
          placeholder={settings?.litellm.hasApiKey ? `保存済み（${settings.litellm.apiKeyMasked ?? '••••'}）` : 'sk-…'}
          autoComplete="off"
        />
        {err?.field === 'key' && <p className="mt-1 text-meta text-st-failed">{err.message}</p>}
        {!compact && <p className="mt-1 text-meta text-fg-3">キーは Core Daemon の設定にだけ保存され、画面には残りません。</p>}
      </div>
      {state.kind === 'ok' && (
        <div className="flex flex-col gap-2 rounded-md border border-line-subtle bg-canvas p-3">
          <div className="flex items-center gap-1.5 text-ui text-st-completed">
            <CheckCircle2 size={14} strokeWidth={1.75} />
            {state.models.length} 個のモデルが使えます
          </div>
          <FieldLabel htmlFor="litellm-model">既定のモデル</FieldLabel>
          <select
            id="litellm-model"
            className={inputClass}
            value={model ?? ''}
            onChange={(e) => setModel(e.target.value)}
          >
            {state.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label ?? m.id}
              </option>
            ))}
          </select>
        </div>
      )}
      {state.kind === 'saved-no-models' && (
        <p className="text-meta text-fg-3">設定を保存しました。モデル一覧の取得は Core Daemon の対応後に使えるようになります。</p>
      )}
      {err && err.field === null && <p className="text-meta text-st-failed">{err.message}</p>}
      <div className="flex justify-end gap-2">
        {state.kind === 'ok' || state.kind === 'saved-no-models' ? (
          <Button type="submit" variant="primary">
            この設定で始める
          </Button>
        ) : (
          <Button
            type="submit"
            variant="primary"
            disabled={!connected || state.kind === 'testing'}
            hint={connected ? undefined : 'Core Daemon に接続していません'}
          >
            {state.kind === 'testing' && <Loader2 size={14} className="animate-spin" />}
            接続テスト
          </Button>
        )}
      </div>
    </form>
  );
}
