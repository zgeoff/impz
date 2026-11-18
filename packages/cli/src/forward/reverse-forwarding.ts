import { createConnection } from 'node:net';
import type { Socket } from 'node:net';
import type { ImpState } from '@impz/api';
import { ORPCError, openReverseForward, watchEvents } from '@impz/client';
import type {
  ReverseForward,
  ReverseForwardEnd,
  ReverseListening,
  ReverseRelay,
  ReverseRelayHandlers,
} from '@impz/client';
import pRetry from 'p-retry';
import { P, match } from 'ts-pattern';
import type { CliConfig } from '../config/cli-config';
import { createImpClient } from '../config/create-imp-client';
import { openBunWebSocket } from '../exec/open-bun-web-socket';
import { waitOrAbort } from '../exec/wait-or-abort';
import type { ReverseLocal, ReverseSpec } from '../parse/parse-reverse';

export interface ReverseIo {
  readonly writeNotice: (text: string) => void;

  // must not wake the imp
  readonly watchImp?: (
    config: CliConfig,
    name: string,
    signal: AbortSignal,
    onState: (state: ImpState) => void,
  ) => Promise<void>;
  readonly wait?: (durationMs: number, signal: AbortSignal) => Promise<void>;
  readonly onWatchedState?: (state: ImpState) => void;
}

export interface ReverseForwarding {
  readonly listening: ReverseListening;
  readonly failed: Promise<Error>;
  readonly stop: () => void;
}

// a sleep reports `sleeping` once the snapshot is on disk, after the guest
// listener ended
const LOST_GRACE_MS = 30_000;

// the WebSocket close code for a connection that closed without a handshake
const CLOSE_ABNORMAL = 1006;
const RETRY_MS = 2000;

const PROCESS_IO: ReverseIo = {
  writeNotice: (text) => {
    console.error(`impz: ${text}`);
  },
};

function watchImpStates(
  config: CliConfig,
  name: string,
  signal: AbortSignal,
  onState: (state: ImpState) => void,
): Promise<void> {
  const client = createImpClient(config);

  return watchEvents(client, {
    name,
    signal,
    reconnect: { delayMs: RETRY_MS },

    // a 4xx, such as NOT_FOUND for an imp destroyed before the stream opened,
    // ends the watch; an impd that is down fails the stream, which opens again
    onOpen: async () => {
      try {
        await client.imps.get({ name }, { signal });
      } catch (error) {
        if (error instanceof ORPCError && error.status >= 400 && error.status < 500) {
          throw error;
        }
      }
    },
    onEvent: (event) => {
      if (event.ev === 'ImpRemoved') {
        throw new Error(`${name} was destroyed`);
      }

      if (event.ev === 'ImpAdded' || event.ev === 'ImpChanged') {
        onState(event.imp.state);
      }
    },
  });
}

export function formatLocal(local: ReverseLocal): string {
  return local.network === 'unix' ? local.path : `localhost:${String(local.port)}`;
}

export function formatGuest(listening: ReverseListening): string {
  return listening.path ?? String(listening.port);
}

function openLocal(local: ReverseLocal): Socket {
  if (local.network === 'unix') {
    return createConnection({ path: local.path, allowHalfOpen: true });
  }

  return createConnection({ host: '127.0.0.1', port: local.port, allowHalfOpen: true });
}

function openLocalRelay(
  accept: (handlers: ReverseRelayHandlers) => ReverseRelay,
  local: ReverseLocal,
  writeNotice: (text: string) => void,
): void {
  const socket = openLocal(local);

  const relay = accept({
    onData: (data) =>
      new Promise<void>((resolve) => {
        socket.write(data, () => {
          resolve();
        });
      }),
    onEof: () => {
      socket.end();
    },
    onClose: () => {
      socket.destroy();
    },
  });

  const waitAndResume = async (): Promise<void> => {
    await relay.waitForRoom();

    socket.resume();
  };

  socket.on('data', (chunk: Buffer) => {
    if (!relay.send(chunk)) {
      socket.pause();
      void waitAndResume();
    }
  });

  socket.on('end', () => {
    relay.sendEof();
  });

  socket.on('error', (error) => {
    writeNotice(`reverse forward to ${formatLocal(local)}: ${error.message}`);
  });

  socket.on('close', () => {
    relay.close();
  });
}

class ForwardLostError extends Error {
  override name = 'ForwardLostError';
}

function formatEnd(end: ReverseForwardEnd): string {
  return match(end)
    .with({ kind: 'failed' }, (failed) => `${failed.code ?? 'error'}: ${failed.message}`)
    .with({ kind: 'closed', code: CLOSE_ABNORMAL }, () => 'could not reach impd')
    .with({ kind: 'closed' }, (closed) => `impd closed it (code ${String(closed.code)})`)
    .with({ kind: P.union('lost', 'stopped') }, () => 'its listener in the imp ended')
    .exhaustive();
}

// after a lost listener the wait first sees the imp leave `running`, so a
// forward never wakes the imp it slept; an imp still running when `grace`
// settles lost only its listener
async function waitForWake(
  watch: (onState: (state: ImpState) => void) => Promise<void>,
  grace: Promise<void> | null,
  onState: (state: ImpState) => void,
): Promise<void> {
  const woke = Promise.withResolvers<void>();
  const progress = { left: grace === null };

  const waitForGrace = async (graceEnd: Promise<void>): Promise<void> => {
    await graceEnd;

    if (!progress.left) {
      woke.resolve();
    }
  };

  const readState = (state: ImpState): void => {
    onState(state);

    if (state !== 'running') {
      progress.left = true;
    } else if (progress.left) {
      woke.resolve();
    }
  };

  const runWatch = async (): Promise<void> => {
    try {
      await watch(readState);

      woke.reject(new Error('the event stream ended'));
    } catch (error) {
      woke.reject(error);
    }
  };

  if (grace !== null) {
    void waitForGrace(grace);
  }

  void runWatch();

  await woke.promise;
}

export async function startReverseForward(
  config: CliConfig,
  name: string,
  spec: ReverseSpec,
  io: ReverseIo = PROCESS_IO,
): Promise<ReverseForwarding> {
  const watching = new AbortController();

  const wait = io.wait ?? waitOrAbort;
  const watchImp = io.watchImp ?? watchImpStates;
  const failed = Promise.withResolvers<Error>();
  const state: { forward: ReverseForward | null } = { forward: null };
  const local = formatLocal(spec.local);

  const openForward = (): ReverseForward => {
    const forward = openReverseForward({
      baseUrl: config.url,
      token: config.token,
      name,
      guest: spec.guest,
      connect: openBunWebSocket,
      onConnection: (accept) => {
        openLocalRelay(accept, spec.local, io.writeNotice);
      },
    });

    state.forward = forward;

    return forward;
  };

  const waitAndListen = async (end: ReverseForwardEnd): Promise<ReverseForward> => {
    if (end.kind === 'closed') {
      await wait(RETRY_MS, watching.signal);
    }

    const waiting = new AbortController();

    const signal = AbortSignal.any([watching.signal, waiting.signal]);
    const grace = end.kind === 'lost' ? wait(LOST_GRACE_MS, signal) : null;

    try {
      await waitForWake(
        (onState) => watchImp(config, name, signal, onState),
        grace,
        io.onWatchedState ?? (() => {}),
      );
    } finally {
      waiting.abort();
    }

    if (watching.signal.aborted) {
      throw new Error('the forward stopped');
    }

    return openForward();
  };

  const runForward = async (first: ReverseForward): Promise<void> => {
    const turn: { forward: ReverseForward; lost: ReverseForwardEnd | null } = {
      forward: first,
      lost: null,
    };

    const holdForward = async (): Promise<void> => {
      if (turn.lost !== null) {
        turn.forward = await waitAndListen(turn.lost);

        try {
          const again = await turn.forward.listening;

          io.writeNotice(`forwarding ${name}:${formatGuest(again)} -> ${local} again`);
        } catch {
          // the forward's `ended` promise reports why
        }
      }

      const end = await turn.forward.ended;

      if (watching.signal.aborted || end.kind === 'stopped') {
        return;
      }

      if (end.kind === 'failed') {
        failed.resolve(new Error(`reverse forward to ${local}: ${formatEnd(end)}`));

        return;
      }

      io.writeNotice(
        `reverse forward to ${local}: ${formatEnd(end)}; listening again once ${name} runs`,
      );

      turn.lost = end;
      throw new ForwardLostError(formatEnd(end));
    };

    try {
      await pRetry(holdForward, {
        retries: Number.POSITIVE_INFINITY,
        minTimeout: 0,
        shouldRetry: (context) => context.error instanceof ForwardLostError,
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));

      if (!watching.signal.aborted) {
        failed.resolve(failure);
      }
    }
  };

  const first = openForward();
  let listening: ReverseListening;

  try {
    listening = await first.listening;
  } catch {
    const end = await first.ended;

    throw new Error(`reverse forward to ${local}: ${formatEnd(end)}`);
  }

  void runForward(first);

  return {
    listening,
    failed: failed.promise,
    stop: () => {
      watching.abort();
      state.forward?.stop();
    },
  };
}
