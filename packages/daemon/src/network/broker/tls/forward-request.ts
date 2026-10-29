import type { Logger } from '@logtape/logtape';
import type { NewAuditEntry } from '../../../platform/db/broker-audit';
import { sendWithCA } from '../../../platform/http/send-with-ca';
import { getErrorMessage } from '../../../platform/process/get-error-message';
import { getImpdLogger } from '../../../platform/process/get-impd-logger';
import { tapStream } from '../../../platform/process/tap-stream';
import type { StreamEnd } from '../../../platform/process/tap-stream';
import { admitRequest } from './admit-request';
import type { Credential } from './admit-request';
import { buildCredentialedHeaders } from './build-credentialed-headers';
import { buildEndToEndHeaders } from './build-end-to-end-headers';
import { isRequestInFilter } from './is-request-in-filter';
import { isWebSocketUpgrade } from './is-websocket-upgrade';

export interface Upstream {
  readonly origin: string;
  readonly ca: readonly string[] | null;
}

export type ResolveUpstream = (host: string) => Upstream;

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
  readonly resolveUpstream: ResolveUpstream;
  readonly recordAudit: (entry: NewAuditEntry) => void;
  readonly fetch?: UpstreamFetch;
  readonly logger?: Pick<Logger, 'warning'>;

  readonly refreshAfterRejection?: (
    secretName: string,
    refreshedAt: number | null,
  ) => Promise<boolean>;
}

export function createForwarder(deps: ForwardDeps): (request: Request) => Promise<Response> {
  const fetchUpstream = deps.fetch ?? sendWithCA;
  const logger = deps.logger ?? getImpdLogger('broker');

  return async (request) => {
    const started = performance.now();

    // answered at once, so a client that tries a WebSocket first falls back to
    // HTTPS without waiting on a stripped upgrade
    if (isWebSocketUpgrade(request.headers)) {
      deps.recordAudit({
        impId: deps.impId,
        impName: deps.impName,
        secretName: null,
        at: new Date(),
        method: request.method,
        host: deps.host,
        path: new URL(request.url).pathname.slice(0, 512),
        status: 426,
        requestBytes: 0,
        responseBytes: 0,
        durationMs: Math.round(performance.now() - started),
        reason: 'websocket',
      });

      return new Response('websocket upgrades are not supported through the broker\n', {
        status: 426,
      });
    }

    const admission = await admitRequest(deps, request, started);

    if (admission.kind === 'refused') {
      return admission.response;
    }

    const credential = admission.credential;
    const url = admission.url;
    const auditPath = admission.auditPath;

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
          path: auditPath,
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
          headers: buildCredentialedHeaders(request.headers, sent),
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
