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

const SWITCHING_PROTOCOLS = 101;

export type UpgradePlan =
  | { readonly kind: 'refused'; readonly response: Response }
  | {
      readonly kind: 'open';
      readonly url: string;
      readonly headers: Headers;
      readonly ca: readonly string[] | null;
      readonly audit: ConnectionAudit;
    };

export interface UpgradeDeps extends AdmitDeps {
  readonly resolveUpstream: ResolveUpstream;
}

export async function planUpgrade(deps: UpgradeDeps, request: Request): Promise<UpgradePlan> {
  const started = performance.now();

  const admission = await admitRequest(deps, request, started);

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

  headers.set('upgrade', request.headers.get('upgrade') ?? '');
  headers.set('connection', 'Upgrade');

  const state: { requestBytes: number; responseBytes: number; phase: UpgradePhase } = {
    requestBytes: 0,
    responseBytes: 0,
    phase: 'pending',
  };

  const writeRow = (status: number, requestBytes: number, responseBytes: number): void => {
    deps.recordAudit({
      impId: deps.impId,
      impName: deps.impName,
      secretName: credential.secretName,
      at: new Date(),
      method: request.method,
      host: deps.host,
      path: admission.auditPath,
      status,
      requestBytes,
      responseBytes,
      durationMs: Math.round(performance.now() - started),
      reason: null,
    });
  };

  return {
    kind: 'open',
    url: `${upstream.origin}${url.pathname}${url.search}`,
    headers,
    ca: upstream.ca,
    audit: {
      recordOpen: () => {
        if (state.phase !== 'pending') {
          return;
        }

        state.phase = 'open';

        writeRow(SWITCHING_PROTOCOLS, 0, 0);
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

        writeRow(SWITCHING_PROTOCOLS, state.requestBytes, state.responseBytes);
      },
      recordAnswer: (status) => {
        if (state.phase !== 'pending') {
          return;
        }

        state.phase = 'done';

        writeRow(status, 0, state.responseBytes);
      },
    },
  };
}
