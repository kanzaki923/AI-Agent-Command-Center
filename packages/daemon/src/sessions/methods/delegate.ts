import { stubMethod } from '../../api/registry';
import type { DaemonContext } from '../../core/context';

/**
 * session.delegate / session.undelegate: let a session lead children (replaces
 * session.grantOrchestration). Placeholders until T1 Supervisor implements them (spec
 * 20261029 §5).
 */
export function sessionDelegate(_ctx: DaemonContext) {
  return stubMethod('session.delegate');
}

export function sessionUndelegate(_ctx: DaemonContext) {
  return stubMethod('session.undelegate');
}
