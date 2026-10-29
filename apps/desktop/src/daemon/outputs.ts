import type { Artifact, OutputKind, ReviewDecision } from '@acc/protocol';
import { useQuery } from '@tanstack/react-query';
import { toastError } from '../store/toast';
import { qk } from './keys';
import { type AppRuntime, useRuntime } from './runtime';

/**
 * Outputs (artifacts with role `output`) of one session or of a whole tree, newest first.
 * New and reviewed outputs refetch the lists (daemon/live.ts).
 */
export function useOutputs(scope: { sessionId: string } | { rootSessionId: string } | null) {
  const rt = useRuntime();
  const key =
    scope && 'rootSessionId' in scope ? qk.outputs('tree', scope.rootSessionId) : qk.outputs('session', scope?.sessionId ?? '');
  return useQuery<Artifact[]>({
    queryKey: key,
    queryFn: () =>
      rt
        .callOr(
          'artifact.list',
          { role: 'output', limit: 100, ...(scope && 'rootSessionId' in scope ? { rootSessionId: scope.rootSessionId } : { sessionId: scope!.sessionId }) },
          { items: [], nextCursor: null },
        )
        .then((r) => r.items),
    enabled: !!scope,
  });
}

/** The UI's kind of an artifact (`diff` is `code`); null for evidence kinds. */
export function outputKind(a: Pick<Artifact, 'kind'>): OutputKind | null {
  switch (a.kind) {
    case 'document':
    case 'data':
    case 'link':
    case 'files':
      return a.kind;
    case 'diff':
      return 'code';
    default:
      return null;
  }
}

/** Content of an output (or of one file of a files output), first page. */
export function useOutputContent(artifactId: string | null | undefined, path: string | null = null) {
  const rt = useRuntime();
  return useQuery({
    queryKey: qk.outputContent(artifactId ?? '', path),
    queryFn: () => rt.client.call('artifact.read', { artifactId: artifactId!, ...(path ? { path } : {}) }),
    enabled: !!artifactId,
    staleTime: 30_000,
  });
}

/**
 * Adopt an output, or send the work back with a note (redo). Adopting code applies it (the
 * daemon starts the integration). Returns the integration id when one was started.
 */
export async function reviewOutput(
  rt: AppRuntime,
  artifactId: string,
  decision: ReviewDecision,
  note?: string,
): Promise<{ integrationId: string | null } | null> {
  try {
    const r = await rt.client.call('artifact.review', { artifactId, decision, ...(note ? { note } : {}) });
    void rt.queryClient.invalidateQueries({ queryKey: ['outputs'] });
    return { integrationId: r.integrationId };
  } catch (err) {
    toastError(err, decision === 'accept' ? '採用できませんでした' : 'やり直しを頼めませんでした');
    return null;
  }
}
