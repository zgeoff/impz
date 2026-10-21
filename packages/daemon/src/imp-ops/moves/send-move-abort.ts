import type { ImpRecord } from '../../platform/db/imps';
import type { StartTimer } from '../../platform/process/clock';
import { MOVE_PATHS, MoveCommitReplySchema } from './move-header';
import { readJsonBody } from './read-json-body';
import { sendToPeer } from './send-to-peer';

interface MoveAbortDeps {
  readonly startPeerDeadline?: StartTimer;
  readonly fetch?: (request: Request) => Promise<Response>;
}

export async function sendMoveAbort(
  deps: MoveAbortDeps,
  imp: ImpRecord,
  peer: string,
  ticket: string,
): Promise<'aborted' | 'committed'> {
  const response = await sendToPeer(deps, peer, MOVE_PATHS.abort, ticket);
  const answer = await readJsonBody(response);

  const reply = MoveCommitReplySchema.safeParse(answer);

  if (reply.success && reply.data.isCommitted) {
    return 'committed';
  }

  const isForgotten = response.status === 401 && imp.moveState === 'sending';

  if (response.ok || isForgotten) {
    return 'aborted';
  }

  throw new Error(`abort: the target answered ${String(response.status)}`);
}
