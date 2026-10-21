import { MOVE_PATHS, MoveOfferReplySchema } from '../../src/imp-ops/moves/move-header';
import type { FetchHook } from './create-move-hosts';

// an older target leaves each of these out of its offer reply, and the source reads a
// missing one as false
type OfferField = 'keepsMaxMemory' | 'keepsLeases' | 'keepsPublicEgress' | 'keepsBackupOff';

export function makeStubOlderMoveTarget(field: OfferField): FetchHook {
  return async (request, forward) => {
    const response = await forward();

    if (!request.url.endsWith(MOVE_PATHS.offer)) {
      return response;
    }

    const body: unknown = await response.json();

    const reply = Object.entries(MoveOfferReplySchema.parse(body)).filter(([key]) => key !== field);

    return Response.json(Object.fromEntries(reply), { status: response.status });
  };
}
