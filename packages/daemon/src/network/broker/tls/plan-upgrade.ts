import { admitRequest } from './admit-request';
import type { AdmitDeps } from './admit-request';
import { buildCredentialedHeaders } from './build-credentialed-headers';
import type { ResolveUpstream, Upstream } from './forward-request';

export interface ConnectionAudit {
  readonly addRequestBytes: (bytes: number) => void;
  readonly addResponseBytes: (bytes: number) => void;

  readonly recordClose: (status: number) => void;
}

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

  const state = { requestBytes: 0, responseBytes: 0, isClosed: false };

  return {
    kind: 'open',
    url: `${upstream.origin}${url.pathname}${url.search}`,
    headers,
    ca: upstream.ca,
    audit: {
      addRequestBytes: (bytes) => {
        state.requestBytes += bytes;
      },
      addResponseBytes: (bytes) => {
        state.responseBytes += bytes;
      },
      recordClose: (status) => {
        if (state.isClosed) {
          return;
        }

        state.isClosed = true;

        deps.recordAudit({
          impId: deps.impId,
          impName: deps.impName,
          secretName: credential.secretName,
          at: new Date(),
          method: request.method,
          host: deps.host,
          path: admission.auditPath,
          status,
          requestBytes: state.requestBytes,
          responseBytes: state.responseBytes,
          durationMs: Math.round(performance.now() - started),
          reason: null,
        });
      },
    },
  };
}
