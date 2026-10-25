import { oc } from '@orpc/contract';
import {
  MoveCommitReplySchema,
  MoveOfferReplySchema,
  MoveOfferSchema,
} from '../schemas/move-peer-schema';

// The routes are plain JSON POSTs, the wire of an impd that predates the contract, so a source and
// a target on either side of that change still move imps between them.
export const movePeerContract = {
  offer: oc
    .route({ method: 'POST', path: '/move/offer' })
    .input(MoveOfferSchema)
    .output(MoveOfferReplySchema),

  commit: oc.route({ method: 'POST', path: '/move/commit' }).output(MoveCommitReplySchema),

  abort: oc.route({ method: 'POST', path: '/move/abort' }).output(MoveCommitReplySchema),
};
