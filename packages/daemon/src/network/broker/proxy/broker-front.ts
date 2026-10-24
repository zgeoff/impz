import { createConnection, createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { pipeline } from 'node:stream';
import type { AuditRefusal, EgressMode } from '@impz/api';
import { findPeerSlot } from '../../../host-net/net/addressing';
import type { Subnet } from '../../../host-net/net/addressing';
import { TunnelRefusedError } from '../../../host-net/net/tunnel-target';
import type { NewAuditEntry } from '../../../platform/db/broker-audit';
import type { BrokerPeer } from '../../../platform/db/read-broker-peer';
import { createCountedLimit } from '../../../platform/process/counted-limit';
import type { CountedLimit } from '../../../platform/process/counted-limit';
import { getErrorMessage } from '../../../platform/process/get-error-message';
import { isTunnelAllowed } from '../../egress/egress-rules';
import type { TerminatorKey } from '../tls/terminators';
import { MAX_HEAD_BYTES, findHeadEnd, parseConnectHead } from './connect-head';

const MAX_CONNECTIONS_PER_IMP = 256;

export interface BrokerFrontDeps {
  readonly subnet: Subnet;
  readonly readPeer: (slot: number) => Promise<BrokerPeer | undefined>;
  readonly isGranted: (impId: string, host: string) => Promise<boolean>;
  readonly openTerminator: (key: TerminatorKey) => Promise<string>;

  readonly resolveTunnelTarget: (host: string, mode: EgressMode) => Promise<string>;

  readonly recordAudit: (entry: NewAuditEntry) => void;
  readonly log: (message: string) => void;

  readonly dialTunnel?: (address: string, port: number) => Socket;

  readonly maxConnectionsPerImp?: number;

  readonly startHeadDeadline?: (durationMs: number) => AbortSignal;
}

export interface BrokerFront {
  readonly server: Server;

  readonly port: number;

  // plain tunnels are relays in impd, which a conntrack flush never reaches,
  // so a tighter policy ends them here
  readonly closeTunnels: (impId: string, keep: (host: string) => boolean) => void;
  readonly stop: () => Promise<void>;
}

export function startBrokerFront(port: number, deps: BrokerFrontDeps): Promise<BrokerFront> {
  const open = createCountedLimit(deps.maxConnectionsPerImp ?? MAX_CONNECTIONS_PER_IMP);
  const tunnels = createTunnelRegistry();

  const sockets = new Set<Socket>();

  const server = createServer((socket) => {
    // two pipelines and the bookkeeping here pass Node's default of 10
    // close listeners, which would only warn
    socket.setMaxListeners(32);
    sockets.add(socket);

    socket.once('close', () => {
      sockets.delete(socket);
    });

    socket.on('error', () => {});
    void handleConnection(socket, deps, open, tunnels);
  });

  const ready = Promise.withResolvers<BrokerFront>();

  server.once('error', ready.reject);

  server.listen(port, '0.0.0.0', () => {
    const address = server.address();

    ready.resolve({
      server,
      port: typeof address === 'object' && address !== null ? address.port : port,
      closeTunnels: tunnels.closeDenied,
      stop: async () => {
        const closed = Promise.withResolvers<void>();

        server.close(() => {
          closed.resolve();
        });

        for (const socket of sockets) {
          socket.destroy();
        }

        await closed.promise;
      },
    });
  });

  return ready.promise;
}

interface TunnelRegistry {
  readonly add: (impId: string, socket: Socket) => void;
  readonly setHost: (impId: string, socket: Socket, host: string) => void;

  readonly drop: (impId: string, socket: Socket) => void;

  readonly isKept: (impId: string, socket: Socket, host: string) => boolean;
  readonly closeDenied: (impId: string, keep: (host: string) => boolean) => void;
}

interface TunnelEntry {
  host: string | null;
  keep: ((host: string) => boolean) | null;
}

function createTunnelRegistry(): TunnelRegistry {
  const tunnels = new Map<string, Map<Socket, TunnelEntry>>();

  return {
    add: (impId, socket) => {
      const own = tunnels.get(impId) ?? new Map<Socket, TunnelEntry>();

      tunnels.set(impId, own);
      own.set(socket, { host: null, keep: null });

      socket.once('close', () => {
        own.delete(socket);

        if (own.size === 0 && tunnels.get(impId) === own) {
          tunnels.delete(impId);
        }
      });
    },
    setHost: (impId, socket, host) => {
      const entry = tunnels.get(impId)?.get(socket);

      if (entry !== undefined) {
        entry.host = host;
      }
    },
    drop: (impId, socket) => {
      tunnels.get(impId)?.delete(socket);
    },
    isKept: (impId, socket, host) => {
      const entry = tunnels.get(impId)?.get(socket);

      return !socket.destroyed && entry !== undefined && (entry.keep?.(host) ?? true);
    },
    closeDenied: (impId, keep) => {
      for (const [socket, entry] of tunnels.get(impId) ?? []) {
        entry.keep = keep;

        if (entry.host !== null && !keep(entry.host)) {
          socket.destroy();
        }
      }
    },
  };
}

async function handleConnection(
  socket: Socket,
  deps: BrokerFrontDeps,
  open: CountedLimit,
  tunnels: TunnelRegistry,
): Promise<void> {
  try {
    await runConnection(socket, deps, open, tunnels);
  } catch (error) {
    deps.log(`impd: broker: ${getErrorMessage(error)}`);
    socket.destroy();
  }
}

interface FrontRefusal {
  readonly status: number;
  readonly message: string;
  readonly reason: AuditRefusal;
  readonly method: string | null;
  readonly host: string | null;
}

const HEAD_TIMEOUT_MS = 10_000;
const KEEPALIVE_MS = 60_000;
const MAX_AUDIT_HOST = 253;

async function runConnection(
  socket: Socket,
  deps: BrokerFrontDeps,
  open: CountedLimit,
  tunnels: TunnelRegistry,
): Promise<void> {
  const started = performance.now();
  const slot = findPeerSlot(socket.remoteAddress ?? '', socket.localAddress ?? '', deps.subnet);

  if (slot === null) {
    socket.destroy();

    return;
  }

  const peer = await deps.readPeer(slot);

  if (peer === undefined) {
    socket.destroy();

    return;
  }

  const sendRefusal = (refusal: Readonly<FrontRefusal>): void => {
    sendReply(socket, refusal.status, refusal.message);

    deps.recordAudit({
      impId: peer.id,
      impName: peer.name,
      secretName: null,
      at: new Date(),
      method: refusal.method,
      host: refusal.host?.slice(0, MAX_AUDIT_HOST) ?? null,
      path: null,
      status: refusal.status,
      requestBytes: 0,
      responseBytes: 0,
      durationMs: Math.round(performance.now() - started),
      reason: refusal.reason,
    });
  };

  const release = open.tryClaim(peer.id);

  if (release === null) {
    sendRefusal({
      status: 503,
      message: 'too many broker connections from this imp',
      reason: 'connection-limit',
      method: null,
      host: null,
    });

    return;
  }

  socket.once('close', release);
  socket.setKeepAlive(true, KEEPALIVE_MS);
  tunnels.add(peer.id, socket);

  const startHeadDeadline =
    deps.startHeadDeadline ?? ((durationMs: number) => AbortSignal.timeout(durationMs));

  const deadline = startHeadDeadline(HEAD_TIMEOUT_MS);

  const read = await readHead(socket, deadline);

  if (read === null) {
    socket.destroy();

    return;
  }

  const head = parseConnectHead(read.head);

  if (head.kind === 'refused') {
    sendRefusal({
      status: head.status,
      message: head.reason,
      reason: head.refusal,
      method: head.method,
      host: null,
    });

    return;
  }

  const granted = head.port === 443 ? await deps.isGranted(peer.id, head.host) : false;

  if (granted) {
    tunnels.drop(peer.id, socket);

    const path = await deps.openTerminator({
      impId: peer.id,
      impName: peer.name,
      host: head.host,
    });

    startRelay(socket, createConnection({ path }), read.rest);

    return;
  }

  tunnels.setHost(peer.id, socket, head.host);

  const current = await deps.readPeer(slot);

  if (current?.id !== peer.id) {
    socket.destroy();

    return;
  }

  const egressRefusal: FrontRefusal = {
    status: 403,
    message: `egress to ${head.host} is not allowed by the imp's egress policy`,
    reason: 'egress-policy',
    method: 'CONNECT',
    host: head.host,
  };

  if (!isTunnelAllowed(current.egress, head.host)) {
    sendRefusal(egressRefusal);

    return;
  }

  let address: string;

  try {
    address = await deps.resolveTunnelTarget(head.host, current.egress.mode);
  } catch (error) {
    if (error instanceof TunnelRefusedError) {
      sendRefusal({
        status: 403,
        message: getErrorMessage(error),
        reason: 'address-refused',
        method: 'CONNECT',
        host: head.host,
      });
    } else {
      sendReply(socket, 502, getErrorMessage(error));
    }

    return;
  }

  if (!tunnels.isKept(peer.id, socket, head.host)) {
    if (!socket.destroyed) {
      sendRefusal(egressRefusal);
    }

    return;
  }

  const dialTunnel = deps.dialTunnel ?? ((host, port) => createConnection({ host, port }));

  startRelay(socket, dialTunnel(address, head.port), read.rest);
}

const REASONS: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  403: 'Forbidden',
  405: 'Method Not Allowed',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

function sendReply(socket: Socket, status: number, message: string): void {
  const body = `${message}\n`;

  socket.end(
    `HTTP/1.1 ${String(status)} ${REASONS[status] ?? 'Error'}\r\n` +
      `content-type: text/plain\r\ncontent-length: ${String(Buffer.byteLength(body))}\r\n` +
      `connection: close\r\n\r\n${body}`,
  );
}

interface HeadRead {
  readonly head: string;
  readonly rest: Uint8Array;
}

function readHead(socket: Socket, deadline: AbortSignal): Promise<HeadRead | null> {
  const done = Promise.withResolvers<HeadRead | null>();
  const chunks: Uint8Array[] = [];

  const resolveRead = (result: HeadRead | null): void => {
    deadline.removeEventListener('abort', onDeadline);
    socket.off('data', onData);
    socket.off('close', onClose);
    socket.pause();
    done.resolve(result);
  };

  const onData = (chunk: Uint8Array): void => {
    chunks.push(chunk);

    const buffered = Buffer.concat(chunks);
    const end = findHeadEnd(buffered);

    if (end !== null) {
      resolveRead({
        head: buffered.subarray(0, end).toString('latin1'),
        rest: buffered.subarray(end),
      });
    } else if (buffered.length > MAX_HEAD_BYTES) {
      resolveRead(null);
    }
  };

  const onClose = (): void => {
    resolveRead(null);
  };

  const onDeadline = (): void => {
    resolveRead(null);
  };

  if (deadline.aborted) {
    resolveRead(null);

    return done.promise;
  }

  deadline.addEventListener('abort', onDeadline, { once: true });
  socket.on('data', onData);
  socket.once('close', onClose);

  return done.promise;
}

function startRelay(client: Socket, upstream: Socket, rest: Uint8Array): void {
  const state = { connected: false };

  upstream.once('connect', () => {
    state.connected = true;

    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    if (rest.length > 0) {
      upstream.write(rest);
    }

    // pipeline carries backpressure and tears both sockets down on an error
    pipeline(client, upstream, () => {
      upstream.destroy();
    });

    pipeline(upstream, client, () => {
      client.destroy();
    });
  });

  client.once('close', () => {
    if (!state.connected) {
      upstream.destroy();
    }
  });

  upstream.once('error', () => {
    if (!state.connected) {
      sendReply(client, 502, 'could not connect');
    }

    upstream.destroy();
  });
}
