import { stubMethod } from '../../api/registry';
import type { DaemonContext } from '../../core/context';

/** session.resume: resume stopped work. Placeholder until T1 Supervisor implements it (spec 20261029 §5). */
export function sessionResume(_ctx: DaemonContext) {
  return stubMethod('session.resume');
}
