import { defineModule } from '../module';
import { locateClaudeCode } from './claude/locate';
import { CLAUDE_RUNTIME_ID, ClaudeAgentSdkRuntime } from './claude/runtime';
import { createAgentExecutor } from './executor';
import { MockAgentRuntime } from './mock/runtime';
import { RuntimeRegistry } from './registry';
import { DbBaselineStore, runtimeMigrations } from './state';

export { ClaudeAgentSdkRuntime, CLAUDE_RUNTIME_ID } from './claude/runtime';
export { locateClaudeCode, CLAUDE_CODE_PATH_ENV } from './claude/locate';
export { MockAgentRuntime } from './mock/runtime';
export { RuntimeRegistry, MOCK_RUNTIME_ID } from './registry';
export { createAgentExecutor, buildAgentPrompt } from './executor';
export { decideToolPermission } from './policy';
export { classifyToolRisk, isHighRiskCommand } from './risk';

/**
 * Agent Runtime abstraction (architecture.md §2.3).
 *
 * - Provides `ctx.service('runtimes')` with the built-in runtimes: "mock" (offline, the
 *   default) and "claude-agent-sdk" (Claude Code via the Agent SDK; LiteLLM when configured).
 * - Registers the "agent" RunExecutor with the runs service in `start()` (after every module
 *   registered), when a runs service exists.
 */
export const runtimeModule = defineModule({
  name: 'runtime',
  migrations: runtimeMigrations,
  register(ctx) {
    const registry = new RuntimeRegistry(() => ctx.settings.get());
    registry.register(new MockAgentRuntime());
    registry.register(
      new ClaudeAgentSdkRuntime({
        settings: () => ctx.settings.get(),
        clientApp: `acc/${ctx.version}`,
        locateExecutable: () => locateClaudeCode(),
        baselines: new DbBaselineStore(ctx.db, ctx.clock, CLAUDE_RUNTIME_ID),
        log: ctx.log.child('claude'),
      }),
    );
    ctx.provide('runtimes', registry);

    return {
      start() {
        if (ctx.hasService('runs')) {
          ctx.service('runs').registerExecutor('agent', createAgentExecutor(ctx));
        } else {
          ctx.log.warn('runs service missing: agent runs cannot execute');
        }
      },
    };
  },
});
