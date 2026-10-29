import type { Actor, Params, Result } from '@acc/protocol';
import type { SpawnOptions, SpawnerService } from '../contracts';
import { ApiError } from '../core/errors';

/**
 * Placeholder of the spawner (T2, architecture.md §2.14): `session.spawn` and schedule
 * firings create children through it once the Spawn track lands.
 */
export class StubSpawner implements SpawnerService {
  spawn(
    _params: Params<'session.spawn'>,
    _actor: Actor,
    _opts?: SpawnOptions,
  ): Promise<Result<'session.spawn'>> {
    return Promise.reject(
      new ApiError('not_found', 'Method not implemented yet: session.spawn', {
        reason: 'not_implemented',
      }),
    );
  }
}
