import { stubMethod } from '../../api/registry';
import type { DaemonContext } from '../../core/context';

/** session.stop: stop a session and, by default, its descendants (paused, resumable). Placeholder until T1 Supervisor implements it (spec 20261029 §5). */
export function sessionStop(_ctx: DaemonContext) {
  return stubMethod('session.stop');
}
