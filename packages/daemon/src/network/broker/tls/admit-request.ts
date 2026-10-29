import type { AuditRefusal, GrantFilter } from '@impz/api';
import type { NewAuditEntry } from '../../../platform/db/broker-audit';
import { isRequestInFilter } from './is-request-in-filter';

export interface Credential {
  readonly secretName: string;
  readonly header: string;
  readonly value: string;

  readonly upstream: string | null;

  readonly filter: GrantFilter | null;

  readonly oauth: { readonly refreshedAt: number | null } | null;
}

export interface AdmitDeps {
  readonly impId: string;
  readonly impName: string;
  readonly host: string;

  readonly findCredential: (impId: string, host: string) => Promise<Credential | null>;
  readonly recordAudit: (entry: NewAuditEntry) => void;
}

export type Admission =
  | { readonly kind: 'refused'; readonly response: Response }
  | {
      readonly kind: 'admitted';
      readonly credential: Credential;
      readonly url: URL;

      readonly auditPath: string;
    };

const MAX_AUDIT_PATH = 512;

export async function admitRequest(
  deps: AdmitDeps,
  request: Request,
  started: number,
  kind: 'request' | 'upgrade',
): Promise<Admission> {
  const url = new URL(request.url);

  const auditPath = url.pathname.slice(0, MAX_AUDIT_PATH);

  const refuse = (status: number, message: string, reason: AuditRefusal): Admission => {
    deps.recordAudit({
      impId: deps.impId,
      impName: deps.impName,
      secretName: null,
      at: new Date(),
      method: request.method,
      host: deps.host,
      path: auditPath,
      status,
      requestBytes: 0,
      responseBytes: 0,
      durationMs: Math.round(performance.now() - started),
      reason,
    });

    return { kind: 'refused', response: new Response(`${message}\n`, { status }) };
  };

  if (findHostName(request.headers.get('host')) !== deps.host) {
    return refuse(421, `this connection is for ${deps.host}`, 'wrong-host');
  }

  // the upstream handshake is always a GET, so the filter must see a GET
  if (kind === 'upgrade' && request.method !== 'GET') {
    return refuse(400, 'a websocket upgrade must be a GET', 'websocket');
  }

  const credential = await deps.findCredential(deps.impId, deps.host);

  if (credential === null) {
    return refuse(403, `no credential is granted for ${deps.host}`, 'no-grant');
  }

  if (
    credential.filter !== null &&
    !isRequestInFilter(credential.filter, request.method, url.pathname)
  ) {
    return refuse(
      403,
      `the grant for ${deps.host} does not cover ${request.method} ${url.pathname}`,
      'outside-filter',
    );
  }

  return { kind: 'admitted', credential, url, auditPath };
}

function findHostName(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const lower = value.toLowerCase();

  return lower.endsWith(':443') ? lower.slice(0, -':443'.length) : lower;
}
