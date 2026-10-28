import { eventsModule } from './events';
import { integrationModule } from './integration';
import { llmModule } from './llm';
import type { DaemonModule } from './module';
import { orchestratorModule } from './orchestrator';
import { policyModule } from './policy';
import { projectsModule } from './projects';
import { runsModule } from './runs';
import { runtimeModule } from './runtime';
import { sessionsModule } from './sessions';
import { systemModule } from './system';
import { tasksModule } from './tasks';
import { workspaceModule } from './workspace';

/**
 * All daemon modules, in registration order. Migrations run in this order too.
 * Services are looked up lazily (`ctx.service(...)` at call time), so order only matters
 * for migrations that depend on another module's tables.
 */
export const modules: DaemonModule[] = [
  systemModule,
  eventsModule,
  projectsModule,
  sessionsModule,
  policyModule,
  llmModule,
  runsModule,
  runtimeModule,
  workspaceModule,
  tasksModule,
  orchestratorModule,
  integrationModule,
];
