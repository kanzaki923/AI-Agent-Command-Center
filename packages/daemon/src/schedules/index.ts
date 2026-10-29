import type { ScheduleOutcome } from '@acc/protocol';
import { stubMethod } from '../api/registry';
import type { SchedulerService } from '../contracts';
import { defineModule } from '../module';

/** Placeholder of the scheduler (T6, architecture.md §2.18): no timer, nothing fires. */
export class StubScheduler implements SchedulerService {
  rearm(): void {}

  fire(
    _scheduleId: string,
    _scheduledFor: string,
  ): Promise<{ sessionId: string | null; outcome: ScheduleOutcome }> {
    return Promise.resolve({ sessionId: null, outcome: 'failed_to_start' });
  }
}

/** Schedules attached to sessions (T6, spec 20261029 §1.9, §3.11). */
export const schedulesModule = defineModule({
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
    ctx.provide('scheduler', new StubScheduler());
    ctx.methods.register(
      stubMethod('schedule.create'),
      stubMethod('schedule.list'),
      stubMethod('schedule.get'),
      stubMethod('schedule.update'),
      stubMethod('schedule.delete'),
      stubMethod('schedule.runNow'),
      stubMethod('schedule.preview'),
    );
  },
});
