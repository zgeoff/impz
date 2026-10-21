import { MOVE_PATHS, MoveOfferReplySchema } from '../../src/imp-ops/moves/move-header';
import type { FetchHook } from './create-move-hosts';

export function makeStubSwitchedStorageTarget(storage: 'xfs' | 'zfs'): FetchHook {
  return async (request, forward) => {
    const response = await forward();

    if (!request.url.endsWith(MOVE_PATHS.offer)) {
      return response;
    }

    const body: unknown = await response.json();

    const reply = MoveOfferReplySchema.parse(body);

    return Response.json({ ...reply, storage }, { status: response.status });
  };
}
