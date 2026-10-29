import { stubMethod } from '../../api/registry';
import type { DaemonContext } from '../../core/context';

/** session.spawn: start a child (calls the `spawner` service, sessions/spawn.ts). Placeholder until T2 Spawn implements it (spec 20261029 §5). */
export function sessionSpawn(_ctx: DaemonContext) {
  return stubMethod('session.spawn');
}
