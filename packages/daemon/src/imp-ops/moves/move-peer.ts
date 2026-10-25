import type { MoveCommitReply, MoveOffer, MoveOfferReply } from '@impz/api';

export interface MovePeer {
  readonly offer: (offer: MoveOffer, signal: AbortSignal) => Promise<MoveOfferReply>;
  readonly commit: () => Promise<MoveCommitReply>;
  readonly abort: () => Promise<'aborted' | 'committed' | 'unknown-ticket'>;
}

interface MovePeerTarget {
  readonly peer: string;
  readonly ticket: string;
}

export type ConnectMovePeer = (target: MovePeerTarget) => MovePeer;
