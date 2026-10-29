import { admitRequest } from './admit-request';
import type { AdmitDeps } from './admit-request';
import { buildCredentialedHeaders } from './build-credentialed-headers';
import type { ResolveUpstream, Upstream } from './forward-request';

export interface ConnectionAudit {
  readonly recordOpen: () => void;
  readonly addRequestBytes: (bytes: number) => void;
  readonly addResponseBytes: (bytes: number) => void;
  readonly recordClose: () => void;

  readonly recordAnswer: (status: number) => void;
}

type UpgradePhase = 'pending' | 'open' | 'done';

interface ByteCounts {
  readonly requestBytes: number;
  readonly responseBytes: number;
}

const SWITCHING_PROTOCOLS = 101;

export type UpgradePlan =
  | { readonly kind: 'refused'; readonly response: Response }
  | {
      readonly kind: 'open';
      readonly url: string;
      readonly headers: Headers;
      readonly protocols: readonly string[];
      readonly ca: readonly string[] | null;
      readonly audit: ConnectionAudit;
    };

const HANDSHAKE_HEADERS = [
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-protocol',
];

export interface UpgradeDeps extends AdmitDeps {
  readonly resolveUpstream: ResolveUpstream;
}

export async function planUpgrade(deps: UpgradeDeps, request: Request): Promise<UpgradePlan> {
  const started = performance.now();
  const requestedAtMs = Date.now();

  const admission = await admitRequest(deps, request, started, 'upgrade');

  if (admission.kind === 'refused') {
    return admission;
  }

  const credential = admission.credential;
  const url = admission.url;

  const upstream: Upstream =
    credential.upstream === null
      ? deps.resolveUpstream(deps.host)
      : { origin: credential.upstream, ca: null };

  const headers = buildCredentialedHeaders(request.headers, credential);

  // the upstream client makes its own handshake, offering the guest's
  // subprotocols
  for (const name of HANDSHAKE_HEADERS) {
    headers.delete(name);
  }

  const protocols = (request.headers.get('sec-websocket-protocol') ?? '')
    .split(',')
    .map((protocol) => protocol.trim())
    .filter((protocol) => protocol !== '');

  const state: {
    requestBytes: number;
    responseBytes: number;
    phase: UpgradePhase;
    openedAtMs: number;
  } = {
    requestBytes: 0,
    responseBytes: 0,
    phase: 'pending',
    openedAtMs: 0,
  };

  const writeRow = (status: number, sinceMs: number, counts: ByteCounts): number => {
    const atMs = Date.now();

    deps.recordAudit({
      impId: deps.impId,
      impName: deps.impName,
      secretName: credential.secretName,
      at: new Date(atMs),
      method: request.method,
      host: deps.host,
      path: admission.auditPath,
      status,
      requestBytes: counts.requestBytes,
      responseBytes: counts.responseBytes,
      durationMs: atMs - sinceMs,
      reason: null,
    });

    return atMs;
  };

  const noBytes = { requestBytes: 0, responseBytes: 0 };

  return {
    kind: 'open',
    url: `${toSocketOrigin(upstream.origin)}${url.pathname}${url.search}`,
    headers,
    protocols,
    ca: upstream.ca,
    audit: {
      recordOpen: () => {
        if (state.phase !== 'pending') {
          return;
        }

        state.phase = 'open';
        state.openedAtMs = writeRow(SWITCHING_PROTOCOLS, requestedAtMs, noBytes);
      },
      addRequestBytes: (bytes) => {
        state.requestBytes += bytes;
      },
      addResponseBytes: (bytes) => {
        state.responseBytes += bytes;
      },
      recordClose: () => {
        if (state.phase !== 'open') {
          return;
        }

        state.phase = 'done';

        writeRow(SWITCHING_PROTOCOLS, state.openedAtMs, state);
      },
      recordAnswer: (status) => {
        if (state.phase !== 'pending') {
          return;
        }

        state.phase = 'done';

        writeRow(status, requestedAtMs, noBytes);
      },
    },
  };
}

function toSocketOrigin(origin: string): string {
  return origin.replace(/^http/u, 'ws');
}
