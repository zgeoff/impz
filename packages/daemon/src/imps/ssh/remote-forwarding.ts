import { posix } from 'node:path';
import type { Connection, ServerChannel } from 'ssh2';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import type { GuestListener, ListenSpec } from '../../vm/agent-client/listener-stream';
import {
  MAX_RELAYS_PER_FORWARD,
  runGuestListener,
} from '../../vm/guest-channels/run-guest-listener';
import { formatFailure, runChannelRelay } from './channel-io';
import type { SshBackend } from './ssh-connection-context';

// ssh2 leaves out both callbacks when a global request wants no reply.
type AcceptRequest = ((chosenPort?: number) => void) | undefined;

type RejectRequest = (() => void) | undefined;

interface TcpForwardRequest {
  readonly kind: 'tcp';
  readonly bindAddr: string;
  readonly bindPort: number;
}

interface SocketForwardRequest {
  readonly kind: 'unix';
  readonly socketPath: string;
}

export type RemoteForwardRequest = TcpForwardRequest | SocketForwardRequest;

export interface RemoteForwarding {
  readonly open: (
    request: RemoteForwardRequest,
    accept: AcceptRequest,
    reject: RejectRequest,
  ) => Promise<void>;
  readonly cancel: (
    request: RemoteForwardRequest,
    accept: AcceptRequest,
    reject: RejectRequest,
  ) => void;
  readonly stop: () => void;
}

interface RemoteForwardingDeps {
  readonly client: Connection;
  readonly impName: string;
  readonly backend: Pick<SshBackend, 'openListener' | 'openAccept'>;
  readonly awake: Promise<void>;
}

interface OpenForward {
  readonly key: string;
  readonly listener: GuestListener;
  readonly label: string;
}

export function createRemoteForwarding(deps: RemoteForwardingDeps): RemoteForwarding {
  const forwards = new Map<string, OpenForward>();
  const opening = new Set<string>();
  const relays = new Map<string, number>();

  const countRelays = (key: string, change: number): void => {
    relays.set(key, (relays.get(key) ?? 0) + change);
  };

  const state = { stopped: false };

  const writeLog = (message: string): void => {
    getImpdLogger('ssh').with({ imp: deps.impName }).info('remote forward {message}', { message });
  };

  const stopGuestClient = async (listener: GuestListener, id: number): Promise<void> => {
    try {
      const stream = await deps.backend.openAccept(deps.impName, listener.id, id, 'ssh');

      stream.close();
    } catch {}
  };

  const openClientChannel = (request: RemoteForwardRequest, port: number): Promise<ServerChannel> =>
    new Promise((resolve, reject) => {
      const handleOpened = (failure: Error | undefined, channel: ServerChannel): void => {
        if (failure === undefined) {
          resolve(channel);
        } else {
          reject(failure);
        }
      };

      if (request.kind === 'unix') {
        deps.client.openssh_forwardOutStreamLocal(request.socketPath, handleOpened);
      } else {
        deps.client.forwardOut(request.bindAddr, port, '127.0.0.1', 0, handleOpened);
      }
    });

  const runClientRelay = async (
    request: RemoteForwardRequest,
    forward: Readonly<OpenForward>,
    port: number,
    id: number,
  ): Promise<void> => {
    countRelays(forward.key, 1);

    try {
      let channel: ServerChannel;

      try {
        channel = await openClientChannel(request, port);
      } catch (error) {
        writeLog(`${forward.label}: the client refused the channel: ${formatFailure(error)}`);

        await stopGuestClient(forward.listener, id);

        return;
      }

      try {
        const relay = await deps.backend.openAccept(deps.impName, forward.listener.id, id, 'ssh');

        await runChannelRelay(channel, relay);
      } catch (error) {
        channel.destroy();

        writeLog(`${forward.label}: ${formatFailure(error)}`);
      }
    } finally {
      countRelays(forward.key, -1);
    }
  };

  const runForward = async (
    request: RemoteForwardRequest,
    forward: Readonly<OpenForward>,
    port: number,
  ): Promise<void> => {
    const key = forward.key;

    try {
      await runGuestListener(forward.listener, {
        deliver: (id) => runClientRelay(request, forward, port, id),
        refuse: (id) => stopGuestClient(forward.listener, id),
        isFull: () => (relays.get(key) ?? 0) >= MAX_RELAYS_PER_FORWARD,
      });
    } catch (error) {
      writeLog(`${forward.label} ended: ${formatFailure(error)}`);
    } finally {
      forward.listener.close();

      if (forwards.get(key) === forward) {
        forwards.delete(key);

        if (!state.stopped) {
          writeLog(`${forward.label} ended with its guest listener`);
        }
      }
    }
  };

  return {
    open: async (request, accept, reject) => {
      const spec = resolveRemoteForward(request);
      const key = buildKey(request);

      const label =
        request.kind === 'unix'
          ? request.socketPath
          : `${request.bindAddr}:${String(request.bindPort)}`;

      if (spec === null || forwards.has(key) || opening.has(key)) {
        writeLog(`${label}: refused`);
        reject?.();

        return;
      }

      let listener: GuestListener;

      opening.add(key);

      try {
        await deps.awake;

        listener = await deps.backend.openListener(deps.impName, spec, null);
      } catch (error) {
        writeLog(`${label}: ${formatFailure(error)}`);
        reject?.();

        return;
      } finally {
        opening.delete(key);
      }

      if (state.stopped) {
        listener.close();

        return;
      }

      const port = listener.port ?? 0;
      const forward: OpenForward = { key, listener, label };

      forwards.set(key, forward);

      if (request.kind === 'tcp' && request.bindPort === 0) {
        accept?.(port);
      } else {
        accept?.();
      }

      void runForward(request, forward, port);
    },
    cancel: (request, accept, reject) => {
      const key = buildKey(request);
      const forward = forwards.get(key);

      if (forward === undefined) {
        reject?.();

        return;
      }

      forwards.delete(key);
      forward.listener.close();
      accept?.();
    },
    stop: () => {
      state.stopped = true;

      for (const forward of forwards.values()) {
        forward.listener.close();
      }

      forwards.clear();
    },
  };
}

// As sshd does with GatewayPorts no, each of these binds listens on the guest's 127.0.0.1.
const LOOPBACK_BINDS = new Set(['', '*', '0.0.0.0', '::', 'localhost', '127.0.0.1', '::1']);

const IMP_RUN_DIR = '/run/imp/';

function resolveRemoteForward(request: RemoteForwardRequest): ListenSpec | null {
  if (request.kind === 'unix') {
    const path = posix.normalize(request.socketPath);

    return posix.isAbsolute(path) && !`${path}/`.startsWith(IMP_RUN_DIR)
      ? { network: 'unix', path }
      : null;
  }

  const port = request.bindPort;

  if (
    !LOOPBACK_BINDS.has(request.bindAddr) ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65_535
  ) {
    return null;
  }

  return { network: 'tcp', port };
}

function buildKey(request: RemoteForwardRequest): string {
  return request.kind === 'unix'
    ? `unix:${posix.normalize(request.socketPath)}`
    : `tcp:${request.bindAddr}:${String(request.bindPort)}`;
}
