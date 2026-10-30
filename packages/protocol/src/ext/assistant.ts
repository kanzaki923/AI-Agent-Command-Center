/**
 * The assistant (作業名「右腕」, snapshot 20261030_right-hand-spec): the one chat that holds the
 * permissions to look over every session tree, start new ones, stop them and set up
 * schedules on the human's behalf. What it may call is a grant the daemon builds; nothing
 * here widens it.
 */
import { z } from 'zod';
import { ProjectId, SessionId } from '../common';
import { Session, WorkspaceSpec } from '../domain';
import { type MethodDef, empty, params } from '../method';

export const assistantMethods = {
  'system.assistant': {
    params: empty(),
    result: z.object({ sessionId: SessionId }),
    description:
      'The assistant conversation (created on first use): the chat the home screen talks to.',
    tool: false,
  },
  'assistant.startWork': {
    params: params({
      text: z
        .string()
        .min(1)
        .max(50_000)
        .describe(
          'The request for this conversation, written by you: only its own piece of what the human asked (split a request that starts several conversations; never pass the whole message to each), keeping their specifics and adding nothing. It becomes the first message of the new conversation, shown as from the assistant',
        ),
      title: z
        .string()
        .max(200)
        .optional()
        .describe('Short name of the work; the first line of the request when omitted'),
      delegate: z
        .boolean()
        .describe(
          'Decide every time. false: one conversation (talking, asking, a chat to open) or one piece of work, by a single agent when a workspace is given; it can run on any model of the list. true: work with several parts that go on side by side and are put together, so the conversation leads a team of children.',
        ),
      projectId: ProjectId.optional().describe('Project the work belongs to'),
      workspace: WorkspaceSpec.optional().describe(
        "Where a single agent works (delegate false): a folder or a project's code (worktree). With delegate true the children get it instead.",
      ),
      model: z.string().min(1).optional(),
    }),
    result: z.object({ session: Session }),
    description:
      'Start a new piece of work as a new root conversation: name it, let it lead children when asked, and send the request as its first message. At most 3 per message of yours.',
    mutates: true,
  },
} as const satisfies Record<string, MethodDef>;
