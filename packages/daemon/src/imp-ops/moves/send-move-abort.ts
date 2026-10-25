import type { ImpRecord } from '../../platform/db/imps';
import type { MovePeer } from './move-peer';

export async function sendMoveAbort(
  peer: Pick<MovePeer, 'abort'>,
  imp: ImpRecord,
): Promise<'aborted' | 'committed'> {
  const outcome = await peer.abort();

  if (outcome !== 'unknown-ticket') {
    return outcome;
  }

  // Before the receipt, a target that lost the ticket can never commit the imp, so the abort has
  // nothing left to undo.
  if (imp.moveState === 'sending') {
    return 'aborted';
  }

  throw new Error('abort: the target holds no such ticket');
}
