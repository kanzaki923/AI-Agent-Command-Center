import { stubMethod } from '../../api/registry';
import type { DaemonContext } from '../../core/context';

/** session.tree: the whole tree as SessionCards. Placeholder until T7 Home implements it (spec 20261029 §5). */
export function sessionTree(_ctx: DaemonContext) {
  return stubMethod('session.tree');
}
