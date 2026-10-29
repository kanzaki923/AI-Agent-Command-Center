import { defineMethod } from '../api/registry';
import { defineModule } from '../module';
import { locateClaudeCode } from './claude/locate';
import { CLAUDE_RUNTIME_ID, ClaudeAgentSdkRuntime } from './claude/runtime';
import { createAgentExecutor } from './executor';
import { MockAgentRuntime } from './mock/runtime';
import { RuntimeRegistry } from './registry';
import { PermissionRuleService, ruleMigrations } from './rules';
import { DbBaselineStore, runtimeMigrations } from './state';

export { ClaudeAgentSdkRuntime, CLAUDE_RUNTIME_ID } from './claude/runtime';
export { locateClaudeCode, CLAUDE_CODE_PATH_ENV } from './claude/locate';
export { MockAgentRuntime } from './mock/runtime';
export { RuntimeRegistry, MOCK_RUNTIME_ID } from './registry';
export { createAgentExecutor, buildAgentPrompt } from './executor';
export { decideToolPermission, grayDecision } from './policy';
export { ToolGate } from './gate';
export { PermissionRuleService, commandKeys, ruleMatches } from './rules';
export { classifyToolRisk, isHighRiskCommand } from './risk';

/**
 * Agent Runtime abstraction (architecture.md §2.3).
 *
 * - Provides `ctx.service('runtimes')` with the built-in runtimes: "mock" (offline, the
 *   default) and "claude-agent-sdk" (Claude Code via the Agent SDK; LiteLLM when configured).
 * - Provides `ctx.service('permissionRules')` (remembered tool approvals) and the methods
 *   permissionRule.list / permissionRule.revoke.
 * - Registers the "agent" RunExecutor with the runs service in `start()` (after every module
 *   registered), when a runs service exists.
 */
export const runtimeModule = defineModule({
  name: 'runtime',
  migrations: [...runtimeMigrations, ...ruleMigrations],
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
        // Live cost estimates (spec §3.8-2), priced by the LLM module's price book.
        pricing: (model) =>
          ctx.hasService('pricing') ? ctx.service('pricing').quote(model) : null,
      }),
    );
    ctx.provide('runtimes', registry);

    const rules = new PermissionRuleService(ctx);
    ctx.provide('permissionRules', rules);
    ctx.methods.register(
      defineMethod('permissionRule.list', {
        scope: (p) => ({ projectIds: [p.projectId] }),
        handler: (p) => ({
          items: rules.repo.find({
            where: p.includeRevoked
              ? { project_id: p.projectId }
              : { project_id: p.projectId, revoked_at: null },
          }),
        }),
      }),
      defineMethod('permissionRule.revoke', {
        scope: (p) => {
          const r = rules.repo.get(p.ruleId);
          return { projectIds: r ? [r.projectId] : [] };
        },
        handler: (p, call) => rules.revoke(p.ruleId, call.actor),
      }),
    );

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
