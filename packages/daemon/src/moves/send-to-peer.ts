import type { StartTimer } from '../process/clock';
import { sendLongRequest } from '../process/send-long-request';
import { MOVE_PATHS } from './move-header';
import { buildTicketHeader } from './move-tickets';

interface PeerDeps {
  // the timer of each request's deadline to the target; setTimeout by default
  readonly startPeerDeadline?: StartTimer;
  readonly fetch?: (request: Request) => Promise<Response>;
}

// a request to the target: the ticket header always, and these besides
export interface PeerRequest {
  readonly body?: string | ReadableStream<Uint8Array>;
  readonly duplex?: 'half';
  readonly signal?: AbortSignal;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

// The target's time to answer, in place of Bun's 360 s limit on a silent
// answer: a part and the finish wait on the target's disk, which can take
// minutes; the offer, the commit and the abort (which removes a copy) less
const PEER_DEADLINES_MS = {
  stream: 60 * 60 * 1000,
  control: 10 * 60 * 1000,
} as const;

export function sendToPeer(
  deps: PeerDeps,
  peer: string,
  path: string,
  ticket: string,
  init: PeerRequest = {},
): Promise<Response> {
  const { extraHeaders, ...rest } = init;
  const ms = path === MOVE_PATHS.receive ? PEER_DEADLINES_MS.stream : PEER_DEADLINES_MS.control;

  // a redirect could send the ticket somewhere else: it fails instead
  return sendLongRequest(
    new URL(path, peer).toString(),
    {
      method: 'POST',
      redirect: 'manual',
      ...rest,
      headers: { ...buildTicketHeader(ticket), ...extraHeaders },
    },
    {
      deadline: {
        ms,
        buildError: () =>
          new Error(`${path}: the target sent no answer in ${String(ms / 60_000)} minutes`),
      },
      ...(deps.startPeerDeadline !== undefined && { startTimer: deps.startPeerDeadline }),
      ...(deps.fetch !== undefined && { send: deps.fetch }),
    },
  );
}
