import type { Server } from 'bun';
import { openUpstreamSocket } from '../../../platform/http/open-upstream-socket';
import type { StartTimer } from '../../../platform/process/clock';
import { startRealTimer } from '../../../platform/process/start-real-timer';
import { planUpgrade } from './plan-upgrade';
import type { UpgradeDeps } from './plan-upgrade';
import type { RelayData } from './relay-socket-handler';
import type { LiveConnections } from './terminators';

export interface RelayDeps extends UpgradeDeps {
  readonly connections: LiveConnections;
  readonly openTimeoutMs?: number;
  readonly startTimer?: StartTimer;
}

const OPEN_TIMEOUT_MS = 10_000;

// RFC 6455's policy violation: the grant that let the connection open is gone
const GRANT_GONE_CODE = 1008;

export async function relayWebSocket(
  deps: RelayDeps,
  request: Request,
  server: Server<RelayData>,
): Promise<Response | undefined> {
  const plan = await planUpgrade(deps, request);

  if (plan.kind === 'refused') {
    return plan.response;
  }

  let upstream: WebSocket;

  try {
    upstream = await openUpstreamSocket(plan.url, plan.protocols, plan.headers, {
      timeoutMs: deps.openTimeoutMs ?? OPEN_TIMEOUT_MS,
      startTimer: deps.startTimer ?? startRealTimer,
      ...(plan.ca !== null && { ca: plan.ca }),
    });
  } catch {
    plan.audit.recordAnswer(502);

    return new Response(`could not open a websocket to ${deps.host}\n`, { status: 502 });
  }

  plan.audit.recordOpen();

  const pending: (string | ArrayBuffer)[] = [];

  const handleEarlyMessage = (event: MessageEvent<string | ArrayBuffer>): void => {
    pending.push(event.data);
  };

  upstream.addEventListener('message', handleEarlyMessage);

  const guest: RelayData['guest'] = { socket: null };

  const untrack = deps.connections.track(() => {
    guest.socket?.close(GRANT_GONE_CODE, 'the grant is gone');
    upstream.close();
  });

  const upgraded = server.upgrade(request, {
    data: { upstream, pending, handleEarlyMessage, audit: plan.audit, untrack, guest },
    ...(upstream.protocol !== '' && { headers: { 'sec-websocket-protocol': upstream.protocol } }),
  });

  if (!upgraded) {
    untrack();

    upstream.close();
    plan.audit.recordClose();

    return new Response('websocket upgrade failed\n', { status: 400 });
  }

  return undefined;
}
