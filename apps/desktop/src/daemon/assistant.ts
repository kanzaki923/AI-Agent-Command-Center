import type { Project } from '@acc/protocol';
import { useQuery } from '@tanstack/react-query';
import type { WorkspaceKind } from '../lib/states';
import { useUi } from '../store/ui';
import { sendMessage } from './actions';
import { qk } from './keys';
import { type AppRuntime, useRuntime } from './runtime';

/**
 * The assistant (作業名「右腕」, snapshot 20261030_right-hand-spec §2): the one conversation the
 * home field talks to. The daemon creates it on first use (`system.assistant`); the id never
 * changes while the daemon lives.
 */
export function assistantQuery(rt: AppRuntime) {
  return {
    queryKey: qk.assistant,
    queryFn: async (): Promise<string> => (await rt.client.call('system.assistant', {})).sessionId,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  };
}

/** The id of the assistant conversation, or null until the daemon answered (or has none). */
export function useAssistantId(): string | null {
  const rt = useRuntime();
  return useQuery<string>(assistantQuery(rt)).data ?? null;
}

/**
 * The place the human chose for the work (the field's workspace toggle), as the one line of
 * context the assistant gets with the message. The project id is in it so the model can pass
 * it on to assistant.startWork.
 */
export function workspaceHint(kind: WorkspaceKind, project: Project | null): string | undefined {
  if (kind === 'worktree' && project?.repoPath) {
    return `コード（プロジェクト「${project.name}」 projectId: ${project.id}）`;
  }
  if (kind === 'folder' && project?.folderPath) {
    return `フォルダ ${project.folderPath} (プロジェクト「${project.name}」 projectId: ${project.id})`;
  }
  return undefined;
}

/**
 * Say something to the assistant (Enter in the home field). The words go as they are; the
 * chosen workspace rides along as a hint. Returns the assistant's session id, or null when
 * nothing was sent (the words stay in the field).
 */
export async function askAssistant(
  rt: AppRuntime,
  text: string,
  opts: { hint?: string | undefined } = {},
): Promise<string | null> {
  let id: string;
  try {
    id = await rt.queryClient.ensureQueryData(assistantQuery(rt));
  } catch {
    return null;
  }
  useUi.getState().noteAssistantAsk(new Date().toISOString());
  const ok = await sendMessage(rt, id, text, { ...(opts.hint ? { hint: opts.hint } : {}) });
  return ok ? id : null;
}
