import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { Server } from 'ssh2';
import type { AuthContext, ClientInfo, Connection } from 'ssh2';
import { createAgentForwarding } from '../../imps/ssh/agent-forwarding';
import { formatFailure } from '../../imps/ssh/channel-io';
import {
  handleForward,
  resolveSocketTarget,
  resolveTcpTarget,
} from '../../imps/ssh/forward-channel';
import { createRemoteForwarding } from '../../imps/ssh/remote-forwarding';
import type { RemoteForwardRequest } from '../../imps/ssh/remote-forwarding';
import { handleSession } from '../../imps/ssh/session-channel';
import type { SshBackend, SshConnectionContext } from '../../imps/ssh/ssh-connection-context';
import type { ImpRecord } from '../../platform/db/imps';
import type { Caller } from '../../platform/principal/caller';
import type { StartTimer } from '../../platform/process/clock';
import { startRealTimer } from '../../platform/process/start-real-timer';
import { findImpRefusal } from '../find-imp-refusal';
import type { LoginKeys } from './login-keys';

interface SshGatewayLimits {
  readonly authTimeoutMs: number;
  readonly maxUnauthenticated: number;
  readonly maxAuthFailures: number;

  // A client that vanished without a FIN would keep its imp awake for good.
  readonly keepaliveIntervalMs: number;
  readonly keepaliveCountMax: number;
}

// OpenSSH's MaxAuthTries is 6; the keepalive drops a silent client after
// about 45 s.
/* @internal */
export const DEFAULT_LIMITS: SshGatewayLimits = {
  authTimeoutMs: 30_000,
  maxUnauthenticated: 32,
  maxAuthFailures: 6,
  keepaliveIntervalMs: 15_000,
  keepaliveCountMax: 3,
};

export interface SshGatewayDeps {
  readonly hostKey: string;
  readonly keys: LoginKeys;
  readonly backend: SshBackend;
  readonly readRevocation: (id: string | null) => AbortSignal | null;
  readonly log: (message: string) => void;
  readonly limits?: Partial<SshGatewayLimits>;
  readonly startTimer?: StartTimer;
}

export interface SshGateway {
  readonly port: number;
  readonly stop: () => Promise<void>;
}

interface PendingSocket {
  readonly socket: Socket;
  readonly cancelTimer: () => void;
}

type LoginOutcome = Login | 'query' | 'rejected';

interface Login {
  readonly imp: ImpRecord;
  readonly caller: Caller;
  readonly keyId: string | null;
}

export async function startSshGateway(
  deps: SshGatewayDeps,
  port: number,
  host: string,
): Promise<SshGateway> {
  const limits: SshGatewayLimits = { ...DEFAULT_LIMITS, ...deps.limits };
  const startTimer = deps.startTimer ?? startRealTimer;

  const pending = new Map<string, PendingSocket>();
  const clients = new Set<Connection>();

  const ssh = new Server(
    {
      hostKeys: [deps.hostKey],
      ident: 'imp',
      keepaliveInterval: limits.keepaliveIntervalMs,
      keepaliveCountMax: limits.keepaliveCountMax,
    },
    (client, info) => {
      const key = buildRemoteKey(info.ip, info.port);
      const entry = pending.get(key);

      if (entry === undefined) {
        client.end();

        return;
      }

      clients.add(client);

      client.on('close', () => {
        clients.delete(client);
      });

      client.on('error', () => {
        client.end();
      });

      handleClient(
        {
          client,
          info,
          socket: entry.socket,
          maxAuthFailures: limits.maxAuthFailures,
          onAuthenticated: () => {
            entry.cancelTimer();
            pending.delete(key);
          },
        },
        deps,
      );
    },
  );

  const listener = createServer((socket) => {
    if (pending.size >= limits.maxUnauthenticated) {
      socket.destroy();

      return;
    }

    const key = buildRemoteKey(socket.remoteAddress ?? '', socket.remotePort ?? 0);

    const cancelTimer = startTimer(() => {
      socket.destroy();
    }, limits.authTimeoutMs);

    pending.set(key, { socket, cancelTimer });

    socket.once('close', () => {
      cancelTimer();

      pending.delete(key);
    });

    ssh.injectSocket(socket);
  });

  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);

    listener.listen(port, host, () => {
      listener.off('error', reject);

      resolve();
    });
  });

  const address = listener.address();

  return {
    port: typeof address === 'object' && address !== null ? address.port : port,
    stop: async () => {
      const closed = new Promise<void>((resolve) => {
        listener.close(() => {
          resolve();
        });
      });

      for (const client of clients) {
        client.end();
      }

      for (const entry of pending.values()) {
        entry.socket.destroy();
      }

      await closed;
    },
  };
}

function buildRemoteKey(ip: string, port: number): string {
  return `${ip} ${String(port)}`;
}

interface HandleClientOptions {
  readonly client: Connection;
  readonly info: ClientInfo;
  readonly socket: Socket;
  readonly maxAuthFailures: number;
  readonly onAuthenticated: () => void;
}

function handleClient(options: HandleClientOptions, deps: SshGatewayDeps): void {
  const client = options.client;
  const info = options.info;
  const login: { granted: Login | null; failures: number } = { granted: null, failures: 0 };

  const handleAuthentication = async (ctx: AuthContext): Promise<void> => {
    let outcome: LoginOutcome;

    try {
      outcome = await checkLogin(ctx, deps);
    } catch (error) {
      deps.log(`impd: ssh: login check failed: ${formatFailure(error)}`);
      ctx.reject(['publickey']);

      return;
    }

    if (outcome === 'rejected') {
      ctx.reject(['publickey']);

      login.failures += 1;

      if (login.failures >= options.maxAuthFailures) {
        client.end();
      }

      return;
    }

    // ssh2 emits `ready` inside accept, so the login is set first.
    if (outcome !== 'query') {
      login.granted = outcome;
    }

    ctx.accept();
  };

  client.on('authentication', (ctx) => {
    void handleAuthentication(ctx);
  });

  client.on('ready', () => {
    const granted = login.granted;

    if (granted === null) {
      client.end();

      return;
    }

    options.onAuthenticated();
    deps.log(`impd: ssh: ${granted.imp.name}: login from ${info.ip} as ${granted.caller.name}`);

    handleLogin(client, granted, buildSshEnv(info, options.socket), deps);
  });
}

// An unknown user, an unknown key and a key without `exec` on the imp get one
// answer, so nobody can probe for imp names.
async function checkLogin(ctx: AuthContext, deps: SshGatewayDeps): Promise<LoginOutcome> {
  if (ctx.method !== 'publickey') {
    return 'rejected';
  }

  const found = deps.keys.readLoginKey(ctx.key.data);

  if (found === null) {
    return 'rejected';
  }

  if (ctx.signature === undefined || ctx.blob === undefined) {
    return 'query';
  }

  if (!found.key.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) {
    return 'rejected';
  }

  // Checked once for the whole connection, which holds only because a token
  // never changes. Checked before the lookup, so the time taken shows nothing
  // of which imps exist.
  if (findImpRefusal(found.caller, 'exec', ctx.username, 'log in to') !== null) {
    return 'rejected';
  }

  const imp = await deps.backend.readImp(ctx.username);

  if (imp === undefined || findImpRefusal(found.caller, 'exec', imp.name, 'log in to') !== null) {
    return 'rejected';
  }

  return { imp, caller: found.caller, keyId: found.keyId };
}

function handleLogin(
  client: Connection,
  granted: Login,
  sshEnv: readonly string[],
  deps: SshGatewayDeps,
): void {
  const imp = granted.imp;
  const backend = deps.backend;
  const release = backend.tracker.open(imp.id, 'ssh');

  const wakeImp = async (): Promise<void> => {
    const running = await backend.requireRunning(imp.name);

    if (running.wokeMs !== null) {
      deps.log(`impd: ssh: ${imp.name} woke in ${String(running.wokeMs)}ms`);
    }

    await backend.recordActivity(imp.name);
  };

  const awake = wakeImp();

  const printWakeFailure = async (): Promise<void> => {
    try {
      await awake;
    } catch (error) {
      deps.log(`impd: ssh: ${imp.name}: could not wake: ${formatFailure(error)}`);
    }
  };

  void printWakeFailure();
  const agent = createAgentForwarding({ client, impName: imp.name, backend, log: deps.log });

  const remote = createRemoteForwarding({
    client,
    impName: imp.name,
    backend,
    awake,
    log: deps.log,
  });

  const context: SshConnectionContext = {
    impName: imp.name,
    actor: { kind: granted.caller.kind, name: granted.caller.name },
    backend,
    awake,
    sshEnv,
    agent,
    log: deps.log,
  };

  const updateLastActive = async (): Promise<void> => {
    await backend.recordActivity(imp.name).catch(() => null);
  };

  const stopWatching = handleRevocations(client, [granted.caller.tokenId, granted.keyId], deps);

  client.on('close', () => {
    release();
    stopWatching();

    agent.stop();
    remote.stop();
    void updateLastActive();
  });

  client.on('session', (accept) => {
    handleSession(accept(), context);
  });

  client.on('tcpip', (accept, reject, request) => {
    void handleForward(accept, reject, resolveTcpTarget(request.destIP, request.destPort), context);
  });

  client.on('openssh.streamlocal', (accept, reject, request) => {
    void handleForward(accept, reject, resolveSocketTarget(request.socketPath), context);
  });

  client.on('request', (accept, reject, name, info) => {
    const request = readForwardRequest(name, info);

    if (readIsCancel(name)) {
      remote.cancel(request, accept, reject);
    } else {
      void remote.open(request, accept, reject);
    }
  });
}

// ssh2 types a global request's info for TCP, but a unix socket request
// carries socketPath.
function readForwardRequest(name: string, info: object): RemoteForwardRequest {
  if (name.includes('streamlocal')) {
    const socketPath: unknown = Reflect.get(info, 'socketPath');

    return { kind: 'unix', socketPath: typeof socketPath === 'string' ? socketPath : '' };
  }

  const bindAddr: unknown = Reflect.get(info, 'bindAddr');
  const bindPort: unknown = Reflect.get(info, 'bindPort');

  return {
    kind: 'tcp',
    bindAddr: typeof bindAddr === 'string' ? bindAddr : '',
    bindPort: typeof bindPort === 'number' ? bindPort : -1,
  };
}

function readIsCancel(name: string): boolean {
  return name.startsWith('cancel-');
}

// The variables as sshd sets them: the client's address and port, then the
// server's.
function buildSshEnv(info: ClientInfo, socket: Socket): readonly string[] {
  const client = `${info.ip} ${String(info.port)}`;
  const localPort = String(socket.localPort ?? 0);

  return [
    `SSH_CONNECTION=${client} ${socket.localAddress ?? ''} ${localPort}`,
    `SSH_CLIENT=${client} ${localPort}`,
  ];
}

function handleRevocations(
  client: Connection,
  ids: readonly (string | null)[],
  deps: SshGatewayDeps,
): () => void {
  const signals = ids.map((id) => deps.readRevocation(id)).filter((signal) => signal !== null);

  const stopClient = (): void => {
    client.end();
  };

  for (const signal of signals) {
    if (signal.aborted) {
      stopClient();
    } else {
      signal.addEventListener('abort', stopClient, { once: true });
    }
  }

  return () => {
    for (const signal of signals) {
      signal.removeEventListener('abort', stopClient);
    }
  };
}
