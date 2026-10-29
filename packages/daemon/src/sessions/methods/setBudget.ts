import { stubMethod } from '../../api/registry';
import type { DaemonContext } from '../../core/context';

/** session.setBudget: set or remove the budget of a session tree. Placeholder until T5 Cost implements it (spec 20261029 §5). */
export function sessionSetBudget(_ctx: DaemonContext) {
  return stubMethod('session.setBudget');
}
