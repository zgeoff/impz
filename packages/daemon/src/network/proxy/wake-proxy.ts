import type { Logger } from '@logtape/logtape';
// oxlint-disable-next-line zgeoff/import-zones -- GEO-364 gives this layer its own errors
import { ORPCError } from '@orpc/server';
import type { Server, WebSocketHandler } from 'bun';
import type { Config } from '../../config';
import { deriveSlotAddress } from '../../host-net/net/addressing';
// oxlint-disable-next-line zgeoff/import-zones -- GEO-364 moves the caller into platform
import { stripSessionCookie } from '../../identity/auth/session-cookie';
import type { ImpRuntime } from '../../imps/imps/imp-runtime';
import type { ImpRecord } from '../../platform/db/imps';
import { listImps } from '../../platform/db/imps';
import type { ImpDatabase } from '../../platform/db/open-database';
import type { StartTimer } from '../../platform/process/clock';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import { createSemaphore } from '../../platform/process/semaphore';
import { startRealTimer } from '../../platform/process/start-real-timer';
// oxlint-disable-next-line zgeoff/import-zones -- GEO-364 gives this layer its own errors
import { MOVING_RETRY_AFTER_S } from '../../surface/api-errors';
import { buildTrackedBody } from './build-tracked-body';
import { buildErrorPage } from './error-pages';
import { PEER_HEADER, isCallerPath } from './forwarded-peers';
import type { ForwardedPeers } from './forwarded-peers';
import { openUpstreamSocket } from './open-upstream-socket';
import { parseHostName } from './parse-host-name';

// hop-by-hop headers (RFC 9110 7.6.1) stay on their own hop
const HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

const UPSTREAM_SOCKET_TIMEOUT_MS = 10_000;

interface SocketData {
  readonly upstream: WebSocket;
  readonly release: () => void;

  readonly pending: (string | ArrayBuffer)[];
  readonly handleEarlyMessage: (event: MessageEvent<string | ArrayBuffer>) => void;
}

interface WakeProxyDeps {
  readonly config: Config;
  readonly db: ImpDatabase;
  readonly imps: Pick<ImpRuntime, 'requireRunning' | 'tracker' | 'recordActivity'>;
  readonly log: (message: string) => void;

  readonly logger?: Pick<Logger, 'warning'>;
  readonly peers: ForwardedPeers;

  readonly ports?: { readonly proxy: number; readonly slot: (slot: number) => number };

  readonly upstreamSocketTimeoutMs?: number;

  readonly startTimer?: StartTimer;
}

interface PublicRequest {
  readonly dropAuthorization: boolean;
  readonly release: () => void;
}

export type ProxyRoute =
  | { readonly kind: 'imp'; readonly name: string; readonly public?: PublicRequest }
  | { readonly kind: 'api' }
  | { readonly kind: 'none'; readonly hint: string }
  | { readonly kind: 'unauthorized'; readonly challenge: string }
  | { readonly kind: 'limited'; readonly detail: string; readonly retryAfterS: number };

export interface ProxyListenOptions {
  readonly port: number;
  readonly hostname?: string;
  readonly tls?: { readonly key: string; readonly cert: string };

  readonly reusePort?: boolean;
  readonly route: (request: Request) => ProxyRoute | Promise<ProxyRoute>;
}

type ProxyServer = Server<SocketData>;

interface UpstreamOptions {
  readonly release: () => void;
  readonly wokeMs: number | null;
  readonly formatFailure: (reason: string) => string;

  readonly toApi: boolean;
  readonly public: PublicRequest | null;

  readonly imp: string | null;
}

export interface WakeProxy {
  readonly syncListeners: () => Promise<void>;

  readonly port: number;

  readonly readImpPort: (impId: string) => number | null;

  readonly startListener: (options: ProxyListenOptions) => ProxyServer;
  readonly stop: () => Promise<void>;
}

export function startWakeProxy(deps: WakeProxyDeps): WakeProxy {
  const listeners = new Map<string, { readonly slot: number; readonly server: ProxyServer }>();
  const failedSlots = new Set<number>();

  const ports = deps.ports ?? {
    proxy: deps.config.proxyPort,
    slot: (slot: number) => deriveSlotAddress(slot, deps.config).tailnetPort,
  };

  const upstreamSocketTimeoutMs = deps.upstreamSocketTimeoutMs ?? UPSTREAM_SOCKET_TIMEOUT_MS;
  const startTimer = deps.startTimer ?? startRealTimer;
  const logger = deps.logger ?? getImpdLogger('proxy');
  const syncSlot = createSemaphore(1);

  const websocket: WebSocketHandler<SocketData> = {
    open: (ws) => {
      const upstream = ws.data.upstream;

      upstream.removeEventListener('message', ws.data.handleEarlyMessage);

      for (const message of ws.data.pending.splice(0)) {
        ws.send(message);
      }

      upstream.addEventListener('message', (event: MessageEvent<string | ArrayBuffer>) => {
        ws.send(event.data);
      });

      // no close can come earlier: Bun runs `open` inside server.upgrade,
      // in the same task as the upstream's open event
      upstream.addEventListener('close', (event) => {
        ws.close(toSendableCode(event.code), event.reason);
      });
    },
    message: (ws, message) => {
      ws.data.upstream.send(message);
    },
    close: (ws, code, reason) => {
      ws.data.release();

      if (ws.data.upstream.readyState <= WebSocket.OPEN) {
        ws.data.upstream.close(toSendableCode(code), reason);
      }
    },
  };

  const handleRequest = async (
    request: Request,
    server: ProxyServer,
    route: ProxyRoute,
  ): Promise<Response | undefined> => {
    if (route.kind === 'none') {
      return buildErrorPage(404, route.hint);
    }

    if (route.kind === 'unauthorized') {
      const page = buildErrorPage(401, 'This imp asks for a token or a password.');

      page.headers.set('www-authenticate', route.challenge);

      return page;
    }

    if (route.kind === 'limited') {
      const page = buildErrorPage(429, route.detail);

      page.headers.set('retry-after', String(route.retryAfterS));

      return page;
    }

    if (route.kind === 'api') {
      return sendUpstream(request, server, `127.0.0.1:${String(deps.config.apiPort)}`, {
        release: () => {},
        wokeMs: null,
        formatFailure: (reason) => `impd's API did not answer (${reason}).`,
        toApi: true,
        public: null,
        imp: null,
      });
    }

    const name = route.name;
    const publicRequest = route.public ?? null;
    const releaseRoute = publicRequest?.release ?? (() => {});
    const opened: { release: () => void } = { release: releaseRoute };
    let running: { readonly imp: ImpRecord; readonly wokeMs: number | null };

    try {
      running = await deps.imps.requireRunning(name, (imp) => {
        const releaseTracker = deps.imps.tracker.open(imp.id, 'proxy');

        opened.release = () => {
          releaseTracker();
          releaseRoute();
        };
      });
    } catch (error) {
      opened.release();

      return publicRequest === null
        ? buildWakeErrorPage(name, error)
        : buildErrorPage(503, 'This site is not available right now.');
    }

    const imp = running.imp;
    const wokeMs = running.wokeMs;

    if (wokeMs !== null) {
      const path = new URL(request.url).pathname;

      deps.log(`impd: proxy: ${name} woke in ${String(wokeMs)}ms for ${request.method} ${path}`);
    }

    try {
      await deps.imps.recordActivity(name);
    } catch {}

    return sendUpstream(request, server, `${imp.ip}:${String(imp.httpPort)}`, {
      release: opened.release,
      wokeMs,
      formatFailure: (reason) =>
        publicRequest === null
          ? `${name} is awake, but nothing answered on port ${String(imp.httpPort)} (${reason}).`
          : 'This site did not answer.',
      toApi: false,
      public: publicRequest,
      imp: name,
    });
  };

  const sendUpstream = async (
    request: Request,
    server: ProxyServer,
    address: string,
    options: UpstreamOptions,
  ): Promise<Response | undefined> => {
    const wokeMs = options.wokeMs;
    const release = options.release;

    const url = new URL(request.url);

    const target = `${address}${url.pathname}${url.search}`;
    const upstreamHeaders = buildUpstreamHeaders(request, server, options.toApi);

    if (options.public?.dropAuthorization === true) {
      upstreamHeaders.delete('authorization');
    }

    const client = server.requestIP(request)?.address;

    // a public client's forwarding headers are whatever it chose to send, so
    // X-Forwarded-For comes from the socket alone
    if (options.public !== null) {
      upstreamHeaders.delete('forwarded');
      upstreamHeaders.delete('x-real-ip');
      upstreamHeaders.delete('x-forwarded-for');

      if (client !== undefined) {
        upstreamHeaders.set('x-forwarded-for', client);
      }
    }

    upstreamHeaders.delete(PEER_HEADER);

    if (options.toApi && client !== undefined && isCallerPath(url.pathname)) {
      upstreamHeaders.set(PEER_HEADER, deps.peers.register(client));
    }

    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      return handleWebSocket(request, server, `ws://${target}`, upstreamHeaders, release);
    }

    try {
      const upstream = await fetch(`http://${target}`, {
        method: request.method,
        headers: upstreamHeaders,
        body: request.body,
        redirect: 'manual',
        decompress: false,
        keepalive: false,

        // Bun's 360 s limit on a silent answer is lifted: an imp's long poll
        // or a long API call ends when its client's own deadline does, since
        // a client that goes away stops the upstream request too
        timeout: false,
        signal: request.signal,
      });

      const headers = new Headers(upstream.headers);

      for (const header of HOP_HEADERS) {
        headers.delete(header);
      }

      if (wokeMs !== null) {
        headers.set('x-imp-wake-ms', String(wokeMs));
      }

      const body =
        upstream.body === null
          ? null
          : buildTrackedBody(upstream.body, release, (failure) => {
              logger.warning('the upstream closed {method} {path} mid-stream: {reason}', {
                ...(options.imp !== null && { imp: options.imp }),
                method: request.method,
                path: url.pathname,
                reason: getErrorMessage(failure),
              });
            });

      if (body === null) {
        release();
      }

      return new Response(body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    } catch (error) {
      release();

      return buildErrorPage(502, options.formatFailure(getErrorMessage(error)));
    }
  };

  const handleWebSocket = async (
    request: Request,
    server: ProxyServer,
    target: string,
    headers: Readonly<Headers>,
    release: () => void,
  ): Promise<Response | undefined> => {
    const protocols = (request.headers.get('sec-websocket-protocol') ?? '')
      .split(',')
      .map((protocol) => protocol.trim())
      .filter((protocol) => protocol !== '');

    let upstream: WebSocket;
    const pending: (string | ArrayBuffer)[] = [];

    try {
      upstream = await openUpstreamSocket(target, protocols, headers, {
        timeoutMs: upstreamSocketTimeoutMs,
        startTimer,
      });
    } catch (error) {
      release();

      const reason = getErrorMessage(error);

      return buildErrorPage(502, `The WebSocket to ${target} failed: ${reason}`);
    }

    const handleEarlyMessage = (event: MessageEvent<string | ArrayBuffer>): void => {
      pending.push(event.data);
    };

    upstream.addEventListener('message', handleEarlyMessage);

    const upgraded = server.upgrade(request, {
      data: { upstream, pending, handleEarlyMessage, release },
      ...(upstream.protocol !== '' && { headers: { 'sec-websocket-protocol': upstream.protocol } }),
    });

    if (!upgraded) {
      upstream.close();

      release();

      return new Response('websocket upgrade failed', { status: 400 });
    }

    return undefined;
  };

  const startListener = (options: ProxyListenOptions): ProxyServer => {
    const handleRoutedRequest = async (request: Request, server: ProxyServer) => {
      const route = await options.route(request);

      return handleRequest(request, server, route);
    };

    return Bun.serve<SocketData>({
      port: options.port,
      ...(options.hostname !== undefined && { hostname: options.hostname }),
      ...(options.tls !== undefined && { tls: options.tls }),
      ...(options.reusePort === true && { reusePort: true }),
      idleTimeout: 0,
      fetch: handleRoutedRequest,
      websocket,
    });
  };

  const hint = `Use http://<imp>.imp.localhost:${String(deps.config.proxyPort)}/.`;

  const main = startListener({
    port: ports.proxy,
    route: (request) => {
      const name = parseHostName(request.headers.get('host'));

      return name === null ? { kind: 'none', hint } : { kind: 'imp', name };
    },
  });

  deps.log(`impd: proxy on :${String(deps.config.proxyPort)}`);

  const runListenerSync = (): Promise<void> =>
    syncSlot.run(async () => {
      const imps = await listImps(deps.db);

      const wanted = new Map(imps.map((imp) => [imp.id, imp]));
      const slots = new Set(imps.map((imp) => imp.slot));

      for (const slot of failedSlots) {
        if (!slots.has(slot)) {
          failedSlots.delete(slot);
        }
      }

      for (const [id, listener] of listeners) {
        if (wanted.get(id)?.slot !== listener.slot) {
          await listener.server.stop(true);

          listeners.delete(id);
        }
      }

      for (const imp of imps) {
        if (listeners.has(imp.id)) {
          continue;
        }

        const port = ports.slot(imp.slot);

        try {
          const route: ProxyRoute = { kind: 'imp', name: imp.name };

          listeners.set(imp.id, {
            slot: imp.slot,
            server: startListener({ port, route: () => route }),
          });

          failedSlots.delete(imp.slot);
        } catch (error) {
          if (!failedSlots.has(imp.slot)) {
            failedSlots.add(imp.slot);

            deps.log(
              `impd: proxy: cannot listen on :${String(port)} for ${imp.name}: ${String(error)}`,
            );
          }
        }
      }
    });

  return {
    syncListeners: runListenerSync,
    port: main.port ?? ports.proxy,
    readImpPort: (impId) => listeners.get(impId)?.server.port ?? null,
    startListener,
    stop: async () => {
      await Promise.all([
        main.stop(true),
        ...[...listeners.values()].map((listener) => listener.server.stop(true)),
      ]);

      listeners.clear();
    },
  };
}

// 1005, 1006 and 1015 describe a close; they cannot be sent in one
function toSendableCode(code: number): number {
  return code === 1000 ||
    (code >= 1001 && code <= 1014 && code !== 1005 && code !== 1006) ||
    (code >= 3000 && code <= 4999)
    ? code
    : 1000;
}

function buildWakeErrorPage(name: string, error: unknown): Response {
  if (error instanceof ORPCError && error.code === 'NOT_FOUND') {
    return buildErrorPage(404, `There is no imp named ${name}.`);
  }

  const reason = getErrorMessage(error);
  const page = buildErrorPage(503, `${name} could not wake: ${reason}`);

  if (error instanceof ORPCError && error.code === 'MOVING') {
    page.headers.set('retry-after', String(MOVING_RETRY_AFTER_S));
  }

  return page;
}

function buildUpstreamHeaders(
  request: Request,
  server: ProxyServer,
  keepSession: boolean,
): Headers {
  const headers = new Headers(request.headers);

  for (const header of HOP_HEADERS) {
    headers.delete(header);
  }

  const socketHeaders = [...headers.keys()].filter((header) => header.startsWith('sec-websocket-'));

  for (const header of socketHeaders) {
    headers.delete(header);
  }

  // a browser sends the dashboard's session cookie to every port of this
  // host, imps' ports too, and an imp must not get it
  const cookie = headers.get('cookie');
  const kept = cookie === null || keepSession ? cookie : stripSessionCookie(cookie);

  if (kept === null) {
    headers.delete('cookie');
  } else {
    headers.set('cookie', kept);
  }

  // one request per upstream connection: an idle keep-alive socket would
  // show as an established TCP connection in the guest and keep it awake
  headers.set('connection', 'close');

  const client = server.requestIP(request)?.address;

  if (client !== undefined) {
    const forwarded = request.headers.get('x-forwarded-for');
    const chain = forwarded === null ? client : `${forwarded}, ${client}`;

    headers.set('x-forwarded-for', chain);
  }

  headers.set('x-forwarded-host', request.headers.get('host') ?? '');

  // https on the domain listeners: Bun gives a TLS request an https URL
  headers.set('x-forwarded-proto', new URL(request.url).protocol.replace(':', ''));

  return headers;
}
