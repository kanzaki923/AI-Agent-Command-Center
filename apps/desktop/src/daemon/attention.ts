import type { Attention, HomeSnapshot } from '@acc/protocol';
import { toastError } from '../store/toast';
import { useUi } from '../store/ui';
import { qk } from './keys';
import { withAttention, withoutAttention } from './live';
import type { AppRuntime } from './runtime';

/** Choice ids that are UI actions, not answers (the daemon refuses them). */
const UI_CHOICES: Record<string, (rt: AppRuntime) => void> = {
  // The daily limit's "設定": open the settings where the limit is changed.
  open_settings: () => useUi.getState().setSettingsOpen(true),
};

export interface AttentionAnswer {
  choiceId?: string;
  text?: string;
}

/**
 * Answer an attention item (spec §1.4 AttentionRow). Optimistic: the item leaves every view
 * at once and stays hidden until the daemon confirms; if the answer fails it comes back where
 * it was, with a toast. Buttons are never disabled while it is on its way.
 */
export async function respondAttention(rt: AppRuntime, attention: Attention, answer: AttentionAnswer): Promise<boolean> {
  const uiAction = answer.choiceId ? UI_CHOICES[answer.choiceId] : undefined;
  if (uiAction && !answer.text) {
    uiAction(rt);
    return true;
  }
  const qc = rt.queryClient;
  rt.live.setAnswering(attention.id, true);
  qc.setQueryData<HomeSnapshot>(qk.home, (cur) => (cur ? withoutAttention(cur, attention.id) : cur));
  try {
    await rt.client.call('attention.respond', {
      attentionId: attention.id,
      ...(answer.choiceId ? { choiceId: answer.choiceId } : {}),
      ...(answer.text ? { text: answer.text } : {}),
    });
    rt.live.setAnswering(attention.id, false);
    return true;
  } catch (err) {
    rt.live.setAnswering(attention.id, false);
    qc.setQueryData<HomeSnapshot>(qk.home, (cur) => (cur ? withAttention(cur, attention) : cur));
    toastError(err, '応答できませんでした');
    return false;
  }
}

/** Dismiss an attention item without acting on it (optimistic like an answer). */
export async function dismissAttention(rt: AppRuntime, attention: Attention): Promise<boolean> {
  const qc = rt.queryClient;
  rt.live.setAnswering(attention.id, true);
  qc.setQueryData<HomeSnapshot>(qk.home, (cur) => (cur ? withoutAttention(cur, attention.id) : cur));
  try {
    await rt.client.call('attention.dismiss', { attentionId: attention.id });
    rt.live.setAnswering(attention.id, false);
    return true;
  } catch (err) {
    rt.live.setAnswering(attention.id, false);
    qc.setQueryData<HomeSnapshot>(qk.home, (cur) => (cur ? withAttention(cur, attention) : cur));
    toastError(err, '閉じられませんでした');
    return false;
  }
}
