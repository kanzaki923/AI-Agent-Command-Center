import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeProvider, createRuntime } from '../../daemon/runtime';
import { useUi } from '../../store/ui';
import { createFakeClient } from '../../test/fakeClient';
import { session } from '../../test/fixtures';
import { TooltipProvider } from '../ui/Tooltip';
import { Composer, composerKeyAction } from './Composer';

const key = (over: Partial<Parameters<typeof composerKeyAction>[0]> = {}) => ({
  key: 'Enter',
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  isComposing: false,
  keyCode: 13,
  ...over,
});

describe('composerKeyAction', () => {
  it('sends on Enter and Ctrl+Enter', () => {
    expect(composerKeyAction(key())).toBe('send');
    expect(composerKeyAction(key({ ctrlKey: true }))).toBe('send');
  });
  it('inserts a newline on Shift+Enter', () => {
    expect(composerKeyAction(key({ shiftKey: true }))).toBe('none');
  });
  it('NEVER sends while an IME is composing', () => {
    expect(composerKeyAction(key({ isComposing: true }))).toBe('none');
    expect(composerKeyAction(key({ keyCode: 229 }))).toBe('none');
    expect(composerKeyAction(key(), true)).toBe('none');
  });
  it('ignores other keys', () => {
    expect(composerKeyAction(key({ key: 'a' }))).toBe('none');
  });
});

describe('<Composer>', () => {
  const s = session({ kind: 'chat', title: 'チャット' });

  function setup() {
    const fake = createFakeClient({
      'session.send': () => ({ messageId: 'msg_00000000000000000000000001', runId: 'run_00000000000000000000000001' }),
      'settings.get': () => ({
        litellm: { baseUrl: null, hasApiKey: false, apiKeyMasked: null },
        defaultModel: null,
        maxConcurrentRuns: 10,
        maxDelegationDepth: 1,
      }),
    });
    const rt = createRuntime(fake.client);
    const onSent = vi.fn();
    render(
      <RuntimeProvider runtime={rt}>
        <TooltipProvider>
          <Composer session={s} activeRun={null} onSent={onSent} />
        </TooltipProvider>
      </RuntimeProvider>,
    );
    const textarea = screen.getByRole('textbox', { name: 'メッセージ' });
    const sends = () => fake.calls.filter((c) => c.method === 'session.send');
    return { fake, textarea, onSent, sends };
  }

  beforeEach(() => {
    useUi.setState({ drafts: {} });
  });

  it('does not send while composing Japanese, then sends after confirming', async () => {
    const { textarea, sends, onSent } = setup();
    fireEvent.change(textarea, { target: { value: 'にほんご' } });

    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true, keyCode: 229 });
    // Some engines report the confirming Enter with isComposing=false: the
    // compositionstart/end guard still blocks it.
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(sends()).toHaveLength(0);
    fireEvent.compositionEnd(textarea);

    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter' });
    });
    expect(sends()).toHaveLength(1);
    expect(sends()[0]!.params).toMatchObject({ sessionId: s.id, content: 'にほんご' });
    expect(onSent).toHaveBeenCalledTimes(1);
    // Optimistic: cleared in the same frame.
    expect((textarea as HTMLTextAreaElement).value).toBe('');
  });

  it('keeps Shift+Enter as a newline and never sends empty text', async () => {
    const { textarea, sends } = setup();
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(sends()).toHaveLength(0);
    fireEvent.change(textarea, { target: { value: '一行目' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(sends()).toHaveLength(0);
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    });
    expect(sends()).toHaveLength(1);
  });

  it('keeps a draft per session in the UI store', () => {
    const { textarea } = setup();
    fireEvent.change(textarea, { target: { value: '下書き' } });
    expect(useUi.getState().drafts[s.id]).toBe('下書き');
  });
});
