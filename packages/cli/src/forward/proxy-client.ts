import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { TUNNEL_CLOSE_LOST, TUNNEL_CLOSE_PROTOCOL, TUNNEL_CLOSE_RESTARTING } from '@impz/api';
import { openForwardTunnel } from '@impz/client';
import type { ForwardTunnelEnd, ForwardTunnelOptions } from '@impz/client';
import { match } from 'ts-pattern';
import { UsageError } from '../cli/errors';
import { toCallError } from '../cli/run-action';
import { loadCliConfig } from '../config/cli-config';
import type { CliConfig } from '../config/cli-config';
import { createImpClient } from '../config/create-imp-client';
import type { CliEnv } from '../config/host-store';
import { openBunWebSocket } from '../exec/open-bun-web-socket';
import { parseForward } from '../parse/parse-forward';
import type { Forward } from '../parse/parse-forward';
import { parseReverse } from '../parse/parse-reverse';
import { formatGuest, formatLocal, startReverseForward } from './reverse-client';
import type { ReverseIo } from './reverse-client';

export interface ProxyIo {
  readonly writeNotice: (text: string) => void;
  readonly now?: () => number;
  readonly reverse?: ReverseIo;
  readonly onWindowFull?: (unackedBytes: number) => void;
  readonly connect?: ForwardTunnelOptions['connect'];
}

export interface Proxy {
  readonly ports: readonly number[];
  readonly stop: () => void;
}

const UNREACHABLE_QUIET_MS = 5000;
const FREE_PORT_TRIES = 5;

// a machine with no IPv6 loopback fails a listen on ::1 with these codes, and
// serves IPv4 only
const NO_IPV6_CODES = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT']);

// a get never wakes the imp
async function checkImpExists(config: CliConfig, name: string): Promise<void> {
  await createImpClient(config).imps.get({ name });
}

const PROCESS_IO: ProxyIo = {
  writeNotice: (text) => {
    console.error(`impz: ${text}`);
  },
};

function findErrorCode(error: unknown): string | null {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;
}

function buildBindError(error: unknown, name: string, forward: Forward): Error {
  const code = findErrorCode(error);
  const remote = String(forward.remote);
  const local = String(forward.local);

  if (code === 'EADDRINUSE') {
    const other = forward.local + 10_000 > 65_535 ? 0 : forward.local + 10_000;

    return new Error(
      `local port ${local} is in use; map another one: impz proxy ${name} ${String(other)}:${remote} (0:${remote} takes any free port)`,
    );
  }

  if (code === 'EACCES') {
    return new Error(
      `local port ${local} needs privileges; map a port above 1023: impz proxy ${name} ${String(forward.local + 8000)}:${remote}`,
    );
  }

  return error instanceof Error ? error : new Error(String(error));
}

export function formatTunnelClose(code: number): string {
  if (code === TUNNEL_CLOSE_LOST) {
    return 'the connection in the imp was lost';
  }

  if (code === TUNNEL_CLOSE_RESTARTING) {
    return 'impd restarted';
  }

  if (code === TUNNEL_CLOSE_PROTOCOL) {
    return 'impd broke the tunnel protocol';
  }

  return `impd closed the tunnel (code ${String(code)})`;
}

function startListener(server: Server, port: number, host: string): Promise<number> {
  const listening = Promise.withResolvers<number>();

  server.once('error', listening.reject);

  server.listen(port, host, () => {
    server.off('error', listening.reject);

    const address = server.address();
    const bound = typeof address === 'object' && address !== null ? address.port : port;

    listening.resolve(bound);
  });

  return listening.promise;
}

interface StartedForward {
  readonly port: number;
  readonly servers: readonly Server[];
}

// both loopbacks, so `localhost` works whichever address it resolves to
async function startForward(
  name: string,
  forward: Forward,
  onConnection: (socket: Socket, remote: number) => void,
): Promise<StartedForward> {
  const createListener = (): Server =>
    createServer({ allowHalfOpen: true, pauseOnConnect: true }, (socket) => {
      onConnection(socket, forward.remote);
    });

  for (let tries = 1; ; tries++) {
    const ipv4 = createListener();
    let port: number;

    try {
      port = await startListener(ipv4, forward.local, '127.0.0.1');
    } catch (error) {
      throw buildBindError(error, name, forward);
    }

    const ipv6 = createListener();

    try {
      await startListener(ipv6, port, '::1');

      return { port, servers: [ipv4, ipv6] };
    } catch (error) {
      const code = findErrorCode(error) ?? '';

      if (NO_IPV6_CODES.has(code)) {
        return { port, servers: [ipv4] };
      }

      ipv4.close();

      if (forward.local === 0 && code === 'EADDRINUSE' && tries < FREE_PORT_TRIES) {
        continue;
      }

      throw buildBindError(error, name, { local: port, remote: forward.remote });
    }
  }
}

interface TunnelTarget {
  readonly baseUrl: string;
  readonly token: string | null;
  readonly name: string;
  readonly port: number;
  readonly connect: ForwardTunnelOptions['connect'];
}

interface TunnelNotices {
  readonly writeNotice: (text: string) => void;
  readonly writeUnreachable: () => void;
  readonly onWindowFull: (unackedBytes: number) => void;
}

function openTunnel(socket: Socket, target: TunnelTarget, notices: TunnelNotices): () => void {
  const label = `${target.name}:${String(target.port)}`;

  const stopSocket = (end: ForwardTunnelEnd): void => {
    match(end)
      .with({ kind: 'done' }, () => {
        socket.end();
      })
      .with({ kind: 'unreachable' }, () => {
        notices.writeUnreachable();
        socket.destroy();
      })
      .with({ kind: 'failed' }, (failed) => {
        notices.writeNotice(`${label}: ${failed.code ?? 'error'}: ${failed.message}`);
        socket.destroy();
      })
      .with({ kind: 'closed' }, (closed) => {
        notices.writeNotice(`${label}: ${formatTunnelClose(closed.code)}`);
        socket.destroy();
      })
      .exhaustive();
  };

  const tunnel = openForwardTunnel({
    ...target,
    onOpened: () => {
      socket.resume();
    },
    onData: (data) =>
      new Promise<void>((resolve) => {
        socket.write(data, () => {
          resolve();
        });
      }),
    onEof: () => {
      socket.end();
    },
    onEnd: stopSocket,
  });

  const waitAndResume = async (): Promise<void> => {
    await tunnel.waitForRoom();

    socket.resume();
  };

  socket.on('data', (chunk: Buffer) => {
    if (!tunnel.send(chunk)) {
      socket.pause();
      notices.onWindowFull(tunnel.countUnackedBytes());
      void waitAndResume();
    }
  });

  // a TCP half-close: the reply may still come back
  socket.on('end', () => {
    tunnel.sendEof();
  });

  // 'close' follows an error, and ends the tunnel
  socket.on('error', () => {});

  socket.on('close', () => {
    tunnel.close();
  });

  return () => {
    socket.destroy();
  };
}

export async function startProxy(
  config: CliConfig,
  name: string,
  forwards: readonly Forward[],
  io: ProxyIo = PROCESS_IO,
): Promise<Proxy> {
  const servers: Server[] = [];

  const tunnels = new Set<() => void>();

  const ports: number[] = [];
  const now = io.now ?? Date.now;
  const state = { ready: false, unreachableAt: Number.NEGATIVE_INFINITY };

  const notices: TunnelNotices = {
    writeNotice: io.writeNotice,
    onWindowFull: io.onWindowFull ?? (() => {}),
    writeUnreachable: () => {
      const failedAt = now();

      if (failedAt - state.unreachableAt > UNREACHABLE_QUIET_MS) {
        io.writeNotice(`could not reach impd at ${config.url}`);
      }

      state.unreachableAt = failedAt;
    },
  };

  const target = {
    baseUrl: config.url,
    token: config.token,
    name,
    connect: io.connect ?? openBunWebSocket,
  };

  const handleConnection = (socket: Socket, remote: number): void => {
    if (!state.ready) {
      socket.destroy();

      return;
    }

    const stopTunnel = openTunnel(socket, { ...target, port: remote }, notices);

    tunnels.add(stopTunnel);

    socket.on('close', () => {
      tunnels.delete(stopTunnel);
    });
  };

  const stop = (): void => {
    for (const server of servers) {
      server.close();
    }

    for (const stopTunnel of tunnels) {
      stopTunnel();
    }
  };

  try {
    for (const forward of forwards) {
      const started = await startForward(name, forward, handleConnection);

      servers.push(...started.servers);
      ports.push(started.port);
    }

    await checkImpExists(config, name);
  } catch (error) {
    stop();
    throw error;
  }

  state.ready = true;

  return { ports, stop };
}

export interface ProxyOptions {
  readonly host: string | null;
  readonly env: CliEnv;
  readonly warn: (line: string) => void;
  readonly name: string;
  readonly specs: readonly string[];
  readonly reverse: readonly string[];
}

interface RunningProxy {
  readonly stop: () => void;
  readonly failed: Promise<Error>;
}

// local forwards start first, so a busy port fails before anything listens
// in the imp or wakes it
async function startForwards(
  config: CliConfig,
  options: ProxyOptions,
  io: ProxyIo,
): Promise<RunningProxy> {
  const forwards = options.specs.map((spec) => parseForward(spec));
  const reverse = options.reverse.map((spec) => parseReverse(spec));

  if (forwards.length === 0 && reverse.length === 0) {
    throw new UsageError('name a port to forward, or a --reverse forward');
  }

  const stops: (() => void)[] = [];
  const failures: Promise<Error>[] = [];

  const stop = (): void => {
    for (const stopOne of stops) {
      stopOne();
    }
  };

  try {
    if (forwards.length > 0) {
      const proxy = await startProxy(config, options.name, forwards, io);

      stops.push(proxy.stop);

      for (const [index, forward] of forwards.entries()) {
        console.log(
          `forwarding localhost:${String(proxy.ports[index])} -> ${options.name}:${String(forward.remote)}`,
        );
      }
    }

    for (const spec of reverse) {
      const forwarding = await startReverseForward(config, options.name, spec, io.reverse);

      stops.push(forwarding.stop);
      failures.push(forwarding.failed);

      console.log(
        `forwarding ${options.name}:${formatGuest(forwarding.listening)} -> ${formatLocal(spec.local)}`,
      );
    }
  } catch (error) {
    stop();
    throw error;
  }

  const failed = failures.length === 0 ? new Promise<Error>(() => {}) : Promise.race(failures);

  return { stop, failed };
}

export async function runProxy(options: ProxyOptions, io: ProxyIo = PROCESS_IO): Promise<void> {
  const config = loadCliConfig(options.env, options.host, options.warn);

  try {
    await runForwards(config, options, io);
  } catch (error) {
    throw toCallError(error, config);
  }
}

async function runForwards(config: CliConfig, options: ProxyOptions, io: ProxyIo): Promise<void> {
  const proxy = await startForwards(config, options, io);

  const stopped = Promise.withResolvers<Error | null>();

  const handleSignal = (): void => {
    stopped.resolve(null);
  };

  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  const failure = await Promise.race([stopped.promise, proxy.failed]);

  process.off('SIGINT', handleSignal);
  process.off('SIGTERM', handleSignal);
  proxy.stop();

  if (failure !== null) {
    throw failure;
  }
}
