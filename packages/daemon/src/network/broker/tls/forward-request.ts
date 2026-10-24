import { METHOD_OVERRIDE_HEADERS } from '@impz/api';
import type { AuditRefusal, GrantFilter } from '@impz/api';
import type { Logger } from '@logtape/logtape';
import type { NewAuditEntry } from '../../../platform/db/broker-audit';
import { sendWithCA } from '../../../platform/http/send-with-ca';
import { getErrorMessage } from '../../../platform/process/get-error-message';
import { getImpdLogger } from '../../../platform/process/get-impd-logger';
import { tapStream } from '../../../platform/process/tap-stream';
import type { StreamEnd } from '../../../platform/process/tap-stream';
import { isRequestInFilter } from './is-request-in-filter';

export interface Credential {
  readonly secretName: string;
  readonly header: string;
  readonly value: string;

  readonly upstream: string | null;

  readonly filter: GrantFilter | null;

  readonly oauth: { readonly refreshedAt: number | null } | null;
}

export interface Upstream {
  readonly origin: string;
  readonly ca: readonly string[] | null;
}

interface UpstreamInit {
  readonly method: string;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;
  readonly redirect: 'manual';
  readonly decompress: false;
  readonly tls?: { readonly ca: readonly string[] };
}

export type UpstreamFetch = (url: string, init: UpstreamInit) => Promise<Response>;

export interface ForwardDeps {
  readonly impId: string;
  readonly impName: string;
  readonly host: string;

  readonly findCredential: (impId: string, host: string) => Promise<Credential | null>;
  readonly resolveUpstream: (host: string) => Upstream;
  readonly recordAudit: (entry: NewAuditEntry) => void;
  readonly fetch?: UpstreamFetch;
  readonly logger?: Pick<Logger, 'warning'>;

  readonly refreshAfterRejection?: (
    secretName: string,
    refreshedAt: number | null,
  ) => Promise<boolean>;
}

const MAX_AUDIT_PATH = 512;

export function createForwarder(deps: ForwardDeps): (request: Request) => Promise<Response> {
  const fetchUpstream = deps.fetch ?? sendWithCA;
  const logger = deps.logger ?? getImpdLogger('broker');

  return async (request) => {
    const started = performance.now();

    const url = new URL(request.url);

    const sendRefusal = (status: number, message: string, reason: AuditRefusal): Response => {
      deps.recordAudit({
        impId: deps.impId,
        impName: deps.impName,
        secretName: null,
        at: new Date(),
        method: request.method,
        host: deps.host,
        path: url.pathname.slice(0, MAX_AUDIT_PATH),
        status,
        requestBytes: 0,
        responseBytes: 0,
        durationMs: Math.round(performance.now() - started),
        reason,
      });

      return new Response(`${message}\n`, { status });
    };

    if (findHostName(request.headers.get('host')) !== deps.host) {
      return sendRefusal(421, `this connection is for ${deps.host}`, 'wrong-host');
    }

    // answered at once, so a client that tries a WebSocket first falls back to
    // HTTPS without waiting on a stripped upgrade
    if (isWebSocketUpgrade(request.headers)) {
      return sendRefusal(
        426,
        'websocket upgrades are not supported through the broker',
        'websocket',
      );
    }

    const credential = await deps.findCredential(deps.impId, deps.host);

    if (credential === null) {
      return sendRefusal(403, `no credential is granted for ${deps.host}`, 'no-grant');
    }

    if (
      credential.filter !== null &&
      !isRequestInFilter(credential.filter, request.method, url.pathname)
    ) {
      return sendRefusal(
        403,
        `the grant for ${deps.host} does not cover ${request.method} ${url.pathname}`,
        'outside-filter',
      );
    }

    const sendWith = async (sent: Readonly<Credential>): Promise<Response> => {
      const counts = { requestBytes: 0, responseBytes: 0 };

      const sendAudit = (status: number): void => {
        deps.recordAudit({
          impId: deps.impId,
          impName: deps.impName,
          secretName: sent.secretName,
          at: new Date(),
          method: request.method,
          host: deps.host,
          path: url.pathname.slice(0, MAX_AUDIT_PATH),
          status,
          requestBytes: counts.requestBytes,
          responseBytes: counts.responseBytes,
          durationMs: Math.round(performance.now() - started),
          reason: null,
        });
      };

      const upstream: Upstream =
        sent.upstream === null
          ? deps.resolveUpstream(deps.host)
          : { origin: sent.upstream, ca: null };

      const headers = buildEndToEndHeaders(request.headers);

      headers.delete('host');

      if (sent.filter !== null) {
        for (const name of METHOD_OVERRIDE_HEADERS) {
          headers.delete(name);
        }
      }

      headers.set(sent.header, sent.value);

      const body =
        request.body === null
          ? null
          : countBytes(request.body, (bytes) => {
              counts.requestBytes = bytes;
            });

      let response: Response;

      try {
        response = await fetchUpstream(`${upstream.origin}${url.pathname}${url.search}`, {
          method: request.method,
          headers,
          body,
          redirect: 'manual',

          // the guest asked for the encoding; it gets the bytes as sent
          decompress: false,
          ...(upstream.ca !== null && { tls: { ca: upstream.ca } }),
        });
      } catch {
        sendAudit(502);

        return new Response(`could not reach ${deps.host}\n`, { status: 502 });
      }

      const responseBody =
        response.body === null
          ? null
          : countBytes(response.body, (bytes, end) => {
              counts.responseBytes = bytes;

              sendAudit(response.status);

              if (end.kind === 'error') {
                logger.warning('the upstream closed {method} {host}{path} mid-stream: {reason}', {
                  imp: deps.impName,
                  method: request.method,
                  host: deps.host,
                  path: url.pathname,
                  reason: getErrorMessage(end.error),
                });
              }
            });

      if (responseBody === null) {
        sendAudit(response.status);
      }

      return new Response(responseBody, {
        status: response.status,
        statusText: response.statusText,
        headers: buildEndToEndHeaders(response.headers),
      });
    };

    const response = await sendWith(credential);

    if (
      response.status !== 401 ||
      credential.oauth === null ||
      deps.refreshAfterRejection === undefined
    ) {
      return response;
    }

    const refreshing = deps.refreshAfterRejection(
      credential.secretName,
      credential.oauth.refreshedAt,
    );

    // a body streamed upstream is consumed, so only a request without one is
    // sent again
    if (request.body !== null) {
      return response;
    }

    if (!(await refreshing)) {
      return response;
    }

    const renewed = await deps.findCredential(deps.impId, deps.host);

    if (
      renewed === null ||
      renewed.oauth === null ||
      renewed.oauth.refreshedAt === credential.oauth.refreshedAt ||
      (renewed.filter !== null && !isRequestInFilter(renewed.filter, request.method, url.pathname))
    ) {
      return response;
    }

    // an upstream that hung up mid-body fails the cancel; the 401 is
    // discarded either way, and the retry goes on
    try {
      await response.body?.cancel();
    } catch {}

    return sendWith(renewed);
  };
}

function findHostName(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const lower = value.toLowerCase();

  return lower.endsWith(':443') ? lower.slice(0, -':443'.length) : lower;
}

function isWebSocketUpgrade(headers: Headers): boolean {
  return (headers.get('upgrade') ?? '')
    .split(',')
    .some((protocol) => protocol.trim().toLowerCase().split('/')[0] === 'websocket');
}

// Per RFC 9110 these describe one connection, not the message, and the proxy
// ones are the guest's to its proxy; this hop answers `expect` itself.
const HOP_HEADERS = [
  'connection',
  'expect',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

function buildEndToEndHeaders(source: Headers): Headers {
  const headers = new Headers(source);

  const named = (source.get('connection') ?? '').split(',').map((name) => name.trim());

  for (const name of [...HOP_HEADERS, ...named]) {
    if (name !== '') {
      headers.delete(name);
    }
  }

  return headers;
}

function countBytes(
  body: ReadableStream<Uint8Array>,
  onEnd: (bytes: number, end: StreamEnd) => void,
): ReadableStream<Uint8Array> {
  const state = { bytes: 0 };

  return tapStream(body, {
    onChunk: (chunk) => {
      state.bytes += chunk.byteLength;
    },
    onEnd: (end) => {
      onEnd(state.bytes, end);
    },
  });
}
