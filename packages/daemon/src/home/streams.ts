import type { StreamingMessage } from '@acc/protocol';
import type { StreamsService } from '../contracts';

/**
 * Placeholder of the streams service (T7, architecture.md §2.19): the run manager hands it
 * every delta (`RunController.emitDelta`); the Home track keeps the text so
 * session.messages can return what is being written right now.
 */
export class StubStreams implements StreamsService {
  append(_runId: string, _messageId: string, _kind: 'text' | 'reasoning', _text: string): void {}

  snapshot(_sessionId: string): StreamingMessage | null {
    return null;
  }
}
