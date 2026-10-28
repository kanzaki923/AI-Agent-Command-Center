import { PROTOCOL_VERSION, RECOVERABLE_RUN_STATUSES } from '@acc/protocol';
import { defineMethod } from '../api/registry';
import { defineModule } from '../module';

/** system.* and settings.* — daemon health, info and persisted settings. */
export const systemModule = defineModule({
  name: 'system',
  register(ctx) {
    ctx.methods.register(
      defineMethod('system.health', {
        handler: () => ({
          ok: true as const,
          version: ctx.version,
          protocolVersion: PROTOCOL_VERSION,
          uptimeMs: Math.max(0, ctx.clock.now() - Date.parse(ctx.startedAt)),
        }),
      }),

      defineMethod('system.info', {
        handler: () => ({
          version: ctx.version,
          protocolVersion: PROTOCOL_VERSION,
          pid: process.pid,
          port: ctx.port,
          startedAt: ctx.startedAt,
          dataDir: ctx.paths.home,
          nodeVersion: process.version,
          platform: process.platform,
          methods: ctx.methods.names(),
          stats: {
            projects: ctx.repos.projects.count({ where: { archived_at: null } }),
            sessions: ctx.repos.sessions.count({ where: { archived_at: null } }),
            activeRuns: ctx.repos.runs.count({ where: { status: [...RECOVERABLE_RUN_STATUSES] } }),
            lastEventSeq: ctx.bus.lastSeq(),
          },
        }),
      }),

      defineMethod('settings.get', {
        handler: () => ctx.settings.view(),
      }),

      defineMethod('settings.update', {
        handler: (params, call) => {
          const changes = ctx.settings.update(params);
          if (changes.length > 0) {
            // Key names only: never put secret values into events.
            ctx.bus.emit({ type: 'settings.updated', actor: call.actor, payload: { changes } });
          }
          return ctx.settings.view();
        },
      }),
    );
  },
});
