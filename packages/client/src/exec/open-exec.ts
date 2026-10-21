import { CONSOLE_SHELL } from '@impz/api';
import type { ExecRequirement, ImpContract, ResumeFrom } from '@impz/api';
import type { ContractRouterClient } from '@orpc/contract';
import { ExecError } from './exec-error';
import { openExecSession } from './open-exec-session';
import type {
  ExecAttach,
  ExecSession,
  ExecSocket,
  ExecStart,
  ExecStarted,
} from './open-exec-session';
import { toExecError } from './to-exec-error';

export interface ExecOptions {
  readonly tty?: boolean;
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly cols?: number;
  readonly rows?: number;
  readonly session?: string;
  readonly killGraceMs?: number;
  readonly resumeFrom?: ResumeFrom;
  readonly require?: readonly ExecRequirement[];
  readonly log?: boolean;
  readonly dropSysAdmin?: boolean;
  readonly signal?: Readonly<AbortSignal>;
  readonly maxUnreadBytes?: number;
}

export interface ExecExit {
  readonly code: number | null;
  readonly signal: string | null;
  readonly offset?: number;
}

export interface ExecHandle {
  readonly started: Promise<ExecStarted>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exit: Promise<ExecExit>;
  readonly write: (data: string | Uint8Array) => Promise<void>;
  readonly closeStdin: () => Promise<void>;
  readonly resize: (cols: number, rows: number) => void;
  readonly sendSignal: (signal: string) => void;
  readonly close: () => void;
}

export interface ExecDeps {
  readonly rpc: Readonly<ContractRouterClient<ImpContract>>;
  readonly baseUrl: string;
  readonly token: string | null;
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly connect?: (url: string) => ExecSocket;
}

export function openExec(
  deps: Readonly<ExecDeps>,
  name: string,
  argv: readonly string[],
  options: Readonly<ExecOptions> = {},
): Promise<ExecHandle> {
  const tty = options.tty ?? false;

  return openHandle(deps, options, tty, {
    name,
    argv,
    tty,
    ...(options.env !== undefined && { env: options.env }),
    ...(options.cwd !== undefined && { cwd: options.cwd }),
    ...(options.cols !== undefined && { cols: options.cols }),
    ...(options.rows !== undefined && { rows: options.rows }),
    ...(options.session !== undefined && { session: options.session }),
    ...(options.killGraceMs !== undefined && { killGraceMs: options.killGraceMs }),
    ...(options.resumeFrom !== undefined && { resumeFrom: options.resumeFrom }),
    ...(options.require !== undefined && { require: options.require }),
    ...(options.log === true && { log: true }),
    ...(options.dropSysAdmin === true && { dropSysAdmin: true }),
  });
}

export interface AttachOptions extends Pick<
  ExecOptions,
  'cols' | 'rows' | 'signal' | 'maxUnreadBytes' | 'resumeFrom'
> {
  readonly wake?: boolean;
}

export function openAttach(
  deps: Readonly<ExecDeps>,
  name: string,
  session: string,
  options: Readonly<AttachOptions> = {},
): Promise<ExecHandle> {
  return openHandle(deps, options, true, {
    name,
    session,
    ...(options.cols !== undefined && { cols: options.cols }),
    ...(options.rows !== undefined && { rows: options.rows }),
    ...(options.resumeFrom !== undefined && { resumeFrom: options.resumeFrom }),
    ...(options.wake !== undefined && { wake: options.wake }),
  });
}

const DEFAULT_MAX_UNREAD_BYTES = 8 * 1024 * 1024;

type Settled<T> = { readonly value: T } | { readonly error: Error };

interface OutputHooks {
  readonly maxUnreadBytes: number;
  readonly onOverflow: (channel: 'stdout' | 'stderr') => void;
  readonly onCancel: () => void;
}

async function openHandle(
  deps: Readonly<ExecDeps>,
  options: Readonly<AttachOptions>,
  tty: boolean,
  start: Readonly<ExecStart | ExecAttach>,
): Promise<ExecHandle> {
  const name = start.name;
  const abort = options.signal;
  const callOptions = abort === undefined ? {} : { signal: abort };

  abort?.throwIfAborted();

  const issued = await deps.rpc.exec.ticket({ name }, callOptions);

  abort?.throwIfAborted();
  const maxUnreadBytes = options.maxUnreadBytes ?? DEFAULT_MAX_UNREAD_BYTES;
  const started = Promise.withResolvers<Settled<ExecStarted>>();
  const ended = Promise.withResolvers<Settled<ExecExit>>();
  const state = { ended: false, cancelled: 0 };

  const stopWith = (code: 'CLOSED' | 'OUTPUT_OVERFLOW', message: string): void => {
    session.stop();

    resolveHandle({ error: new ExecError(code, message) });
  };

  const outputHooks: OutputHooks = {
    maxUnreadBytes,
    onOverflow: (channel) => {
      stopWith(
        'OUTPUT_OVERFLOW',
        `${channel} holds more than ${String(maxUnreadBytes)} unread bytes; read or cancel it`,
      );
    },
    onCancel: () => {
      state.cancelled += 1;

      if (state.cancelled === 2) {
        stopWith('CLOSED', 'both output streams were cancelled');
      }
    },
  };

  const stdout = buildOutputStream('stdout', outputHooks);
  const stderr = buildOutputStream('stderr', outputHooks);

  const session = openExecSession({
    baseUrl: deps.baseUrl,
    token: deps.token,
    ticket: issued.ticket,
    start,
    onStarted: (info) => {
      started.resolve({ value: info });
    },
    onOutput: (channel, data) => {
      const target = channel === 'stderr' ? stderr : stdout;

      target.push(data);
    },
    connect: deps.connect ?? ((url) => new WebSocket(url)),
    ...(deps.fetch !== undefined && { fetch: deps.fetch }),
  });

  const resolveHandle = (result: Settled<ExecExit>): void => {
    if (state.ended) {
      return;
    }

    state.ended = true;

    stdout.end();
    stderr.end();
    abort?.removeEventListener('abort', stopForAbort);

    if ('error' in result) {
      started.resolve({ error: result.error });
    }

    ended.resolve(result);
  };

  const stopSession = (): void => {
    stopWith('CLOSED', 'the exec session was closed');
  };

  const stopForAbort = (): void => {
    if (session.isStarted()) {
      stopSession();

      return;
    }

    session.stop();

    resolveHandle({ error: readAbortReason(abort) });
  };

  const waitForOutcome = async (): Promise<void> => {
    const outcome = await session.outcome;

    const result: Settled<ExecExit> =
      outcome.kind === 'exit'
        ? {
            value: {
              code: outcome.code,
              signal: outcome.signal,
              ...(outcome.offset !== undefined && { offset: outcome.offset }),
            },
          }
        : { error: toExecError(outcome) };

    resolveHandle(result);
  };

  if (abort?.aborted === true) {
    stopForAbort();
  } else {
    abort?.addEventListener('abort', stopForAbort, { once: true });
  }

  void waitForOutcome();

  return createHandle(session, {
    started: started.promise,
    ended: ended.promise,
    isEnded: () => state.ended,
    tty,
    stopSession,
    streams: [stdout.stream, stderr.stream],
  });
}

function buildOutputStream(channel: 'stdout' | 'stderr', hooks: Readonly<OutputHooks>) {
  const state: { controller: ReadableStreamDefaultController<Uint8Array> | null; open: boolean } = {
    controller: null,
    open: true,
  };

  const stream = new ReadableStream<Uint8Array>(
    {
      start: (controller) => {
        state.controller = controller;
      },
      cancel: () => {
        state.open = false;

        hooks.onCancel();
      },
    },
    { highWaterMark: hooks.maxUnreadBytes, size: (chunk) => chunk?.byteLength ?? 0 },
  );

  return {
    stream,
    push: (data: Uint8Array) => {
      if (!state.open || state.controller === null) {
        return;
      }

      state.controller.enqueue(data);

      if ((state.controller.desiredSize ?? 0) < 0) {
        hooks.onOverflow(channel);
      }
    },
    end: () => {
      if (state.open) {
        state.open = false;
        state.controller?.close();
      }
    },
  };
}

function readAbortReason(abort: Readonly<AbortSignal> | undefined): Error {
  const reason: unknown = abort?.reason;

  return reason instanceof Error ? reason : new DOMException('the exec was aborted', 'AbortError');
}

export type ConsoleOptions = Omit<ExecOptions, 'tty'>;

export function openConsole(
  deps: Readonly<ExecDeps>,
  name: string,
  options: Readonly<ConsoleOptions> = {},
): Promise<ExecHandle> {
  return openExec(deps, name, ['/bin/sh', '-c', CONSOLE_SHELL], {
    ...options,
    tty: true,
    env: options.env ?? { TERM: 'xterm-256color' },
  });
}

export interface RunResult extends ExecExit {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export interface RunOptions extends Omit<ExecOptions, 'tty' | 'cols' | 'rows'> {
  readonly stdin?: string | Uint8Array;
}

export async function runCommand(
  deps: Readonly<ExecDeps>,
  name: string,
  argv: readonly string[],
  options: Readonly<RunOptions> = {},
): Promise<RunResult> {
  const handle = await openExec(deps, name, argv, options);

  // Both streams drain at once, because a command that fills stderr while
  // the caller waits on stdout would stall.
  const output = Promise.all([readAll(handle.stdout), readAll(handle.stderr)]);

  if (options.stdin !== undefined) {
    await handle.write(options.stdin).catch(checkWriteFailure);
  }

  await handle.closeStdin();

  const [exit, [stdout, stderr]] = await Promise.all([handle.exit, output]);

  return { ...exit, stdout, stderr };
}

// impd, as Bun serves it, closes a socket that sends one frame over 16 MiB.
const STDIN_FRAME_BYTES = 1024 ** 2;

function checkWriteFailure(error: unknown): void {
  if (!(error instanceof ExecError && error.code === 'CLOSED')) {
    throw error;
  }
}

interface HandleParts {
  readonly started: Promise<Settled<ExecStarted>>;
  readonly ended: Promise<Settled<ExecExit>>;
  readonly isEnded: () => boolean;
  readonly tty: boolean;
  readonly stopSession: () => void;
  readonly streams: readonly [ReadableStream<Uint8Array>, ReadableStream<Uint8Array>];
}

// The terminal turns a typed key into a signal for the foreground job, where a
// plain signal reaches only the shell.
const TTY_SIGNAL_KEYS: Readonly<Record<string, string>> = { SIGINT: '\u0003', SIGQUIT: '\u001C' };

function createHandle(session: ExecSession, parts: Readonly<HandleParts>): ExecHandle {
  const encoder = new TextEncoder();

  const waitForStart = async (): Promise<ExecStarted> => {
    const result = await parts.started;

    if ('error' in result) {
      throw result.error;
    }

    return result.value;
  };

  const waitForExit = async (): Promise<ExecExit> => {
    const result = await parts.ended;

    if ('error' in result) {
      throw result.error;
    }

    return result.value;
  };

  const startedPromise = waitForStart();
  const exitPromise = waitForExit();

  void waitIgnoringRejection(startedPromise);
  void waitIgnoringRejection(exitPromise);
  const end: { error: Error | null } = { error: null };

  void (async () => {
    const result = await parts.ended;

    if ('error' in result) {
      end.error = result.error;
    }
  })();

  const requireOpen = (): void => {
    if (!parts.isEnded()) {
      return;
    }

    throw end.error ?? new ExecError('CLOSED', 'the exec session has ended');
  };

  const write = async (data: string | Uint8Array): Promise<void> => {
    requireOpen();

    await startedPromise;

    requireOpen();

    const bytes = typeof data === 'string' ? encoder.encode(data) : data;

    for (let sent = 0; sent < bytes.byteLength; sent += STDIN_FRAME_BYTES) {
      requireOpen();

      if (!session.sendStdin(bytes.subarray(sent, sent + STDIN_FRAME_BYTES))) {
        await session.waitForDrain();
      }
    }
  };

  const sendKey = async (key: string): Promise<void> => {
    try {
      await write(key);
    } catch {
      // the exit promise reports why
    }
  };

  return {
    started: startedPromise,
    stdout: parts.streams[0],
    stderr: parts.streams[1],
    exit: exitPromise,
    write,
    closeStdin: async () => {
      await startedPromise;

      if (!parts.isEnded()) {
        session.closeStdin();
      }
    },
    resize: (cols, rows) => {
      session.resize(cols, rows);
    },
    sendSignal: (signal) => {
      const key = parts.tty ? TTY_SIGNAL_KEYS[signal] : undefined;

      if (key === undefined) {
        session.sendSignal(signal);
      } else {
        void sendKey(key);
      }
    },
    close: parts.stopSession,
  };
}

async function waitIgnoringRejection(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    // the caller reads the rejection itself
  }
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const buffer = await new Response(stream).arrayBuffer();

  return new Uint8Array(buffer);
}
