import { MOVE_RECEIVE_PATH } from '@impz/api';
import type { StartTimer } from '../../platform/process/clock';
import { sendLongRequest } from '../../platform/process/send-long-request';
import { buildTicketHeader } from './move-tickets';

export interface PeerDeps {
  readonly startPeerDeadline?: StartTimer;
  readonly fetch?: (request: Request) => Promise<Response>;
}

interface PeerRequest {
  readonly body?: string | ReadableStream<Uint8Array>;
  readonly duplex?: 'half';
  readonly signal?: AbortSignal;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

// Bun gives up on a silent answer after 360 s, but a part and the finish wait
// on the target's disk for longer, so each request carries its own deadline.
const PEER_DEADLINES_MS = {
  stream: 60 * 60 * 1000,
  control: 10 * 60 * 1000,
} as const;

interface SendToPeerOptions {
  readonly peer: string;
  readonly path: string;
  readonly ticket: string;
  readonly init?: PeerRequest;
}

export function sendToPeer(deps: PeerDeps, options: SendToPeerOptions): Promise<Response> {
  const path = options.path;
  const { extraHeaders, ...rest } = options.init ?? {};

  const durationMs =
    path === MOVE_RECEIVE_PATH ? PEER_DEADLINES_MS.stream : PEER_DEADLINES_MS.control;

  // A followed redirect could send the ticket to another host.
  return sendLongRequest(
    new URL(path, options.peer).toString(),
    {
      method: 'POST',
      redirect: 'manual',
      ...rest,
      headers: { ...buildTicketHeader(options.ticket), ...extraHeaders },
    },
    {
      deadline: {
        delayMs: durationMs,
        buildError: () =>
          new Error(`${path}: the target sent no answer in ${String(durationMs / 60_000)} minutes`),
      },
      ...(deps.startPeerDeadline !== undefined && { startTimer: deps.startPeerDeadline }),
      ...(deps.fetch !== undefined && { send: deps.fetch }),
    },
  );
}
