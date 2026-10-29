import { defineModule } from '../module';
import { scheduleMethods } from './methods';
import { Scheduler, type SchedulerOptions } from './scheduler';

export {
  Scheduler,
  SCHEDULER_ACTOR,
  PREVIOUS_OUTPUT_CHARS,
  artifactExcerpt,
  realTimers,
  type FireResult,
  type SchedulerOptions,
  type TimerHost,
} from './scheduler';
export { DEFAULT_MAX_SCHEDULES, defaultTitle } from './methods';
export {
  SKIP_LATENESS_MS,
  firingLabel,
  latestFireAtOrBefore,
  nextFireAfter,
  nextFires,
  nextRunAfter,
  normalizeTrigger,
  planDue,
} from './time';

/**
 * Schedules attached to sessions (T6, architecture.md §2.18, spec 20261029 §1.9, §3.11).
 * `createSchedulesModule({ spawner, timers })` lets tests drive firings with a fake spawner
 * and a manual timer.
 */
export function createSchedulesModule(opts: SchedulerOptions = {}) {
  return defineModule({
    name: 'schedules',
    migrations: [
      {
        id: 'schedules/0001_init',
        sql: `
CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  next_run_at TEXT,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX schedules_next ON schedules(enabled, next_run_at);
CREATE INDEX schedules_session ON schedules(session_id);
`,
      },
    ],
    register(ctx) {
      const scheduler = new Scheduler(ctx, opts);
      ctx.provide('scheduler', scheduler);
      ctx.methods.register(...scheduleMethods(ctx, scheduler));
      return {
        // Startup: run the latest missed firing (if still on time), then arm the timer.
        start: () => scheduler.start(),
        stop: () => scheduler.stop(),
      };
    },
  });
}

export const schedulesModule = createSchedulesModule();
