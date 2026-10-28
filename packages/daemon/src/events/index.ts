import type { EventFilter } from '@acc/protocol';
import { defineMethod } from '../api/registry';
import { invalidParams, notFound } from '../core/errors';
import { defineModule } from '../module';

/**
 * events.list / events.subscribe / events.unsubscribe.
 *
 * Resume protocol for clients: subscribe first, then page `events.list({ since: lastSeq })`
 * until `hasMore` is false, de-duplicating live events by `seq`. (@acc/client does this.)
 */
export const eventsModule = defineModule({
  name: 'events',
  register(ctx) {
    ctx.methods.register(
      defineMethod('events.list', {
        scope: (p) => ({ projectIds: p.projectId ? [p.projectId] : [] }),
        handler: (p) => ctx.bus.list(p),
      }),

      defineMethod('events.subscribe', {
        scope: (p) => ({ projectIds: p.projectId ? [p.projectId] : [] }),
        handler: (p, call) => {
          const conn = call.connection;
          if (!conn) throw invalidParams('events.subscribe requires a WebSocket connection');
          const { deltas, ...rest } = p;
          const filter: EventFilter = rest;
          const subscriptionId = ctx.ids.next('subscription');
          const offEvents = ctx.bus.subscribe(filter, (event) =>
            conn.send({ type: 'event', subscriptionId, event }),
          );
          const offDeltas = deltas
            ? ctx.bus.subscribeDeltas(filter, (delta) =>
                conn.send({ type: 'delta', subscriptionId, delta }),
              )
            : () => {};
          conn.subscriptions.set(subscriptionId, () => {
            offEvents();
            offDeltas();
          });
          // Subscribed synchronously above, so every event with seq > lastSeq is pushed.
          return { subscriptionId, lastSeq: ctx.bus.lastSeq() };
        },
      }),

      defineMethod('events.unsubscribe', {
        handler: (p, call) => {
          const conn = call.connection;
          const off = conn?.subscriptions.get(p.subscriptionId);
          if (!conn || !off) throw notFound('subscription', p.subscriptionId);
          off();
          conn.subscriptions.delete(p.subscriptionId);
          return { ok: true as const };
        },
      }),
    );
  },
});
