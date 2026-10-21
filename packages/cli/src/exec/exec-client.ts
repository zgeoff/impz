import { openExecSession } from '@impz/client';
import type { ExecRequirement, ExecSession, ExecSessionOptions } from '@impz/client';
import pRetry from 'p-retry';
import { readProcessIO } from '../cli/command-io';
import type { CommandIO, CommandStdin } from '../cli/command-io';
import { toSignalExitCode } from '../cli/to-signal-exit-code';
import { loadCliConfig } from '../config/cli-config';
import type { CliConfig } from '../config/cli-config';
import { createImpClient } from '../config/create-imp-client';
import { advanceExec, formatSession } from './advance-exec';
import type { ExecEvent, ExecMachine, ExecStep } from './advance-exec';
import { findDetachKey } from './detach-key';
import { openBunWebSocket } from './open-bun-web-socket';
import { createModeWatcher } from './terminal-modes';

export interface ExecOptions {
  readonly host: string | null;
  readonly name: string;
  readonly argv: readonly string[];
  readonly tty: boolean;
  readonly env?: Readonly<Record<string, string>>;
  readonly session?: SessionOptions;

  // the SDK passes the start through as it is, but leaves this field out of
  // its types
  readonly outer?: boolean;
  readonly require?: readonly ExecRequirement[];
}

interface SessionOptions {
  readonly name: string;
  readonly attachOnly: boolean;
  readonly detachKey: number | null;
  readonly log?: boolean;
}

export interface ExecIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdin: CommandStdin;
  readonly writeOutput: (fd: 1 | 2, data: Uint8Array) => void;
  readonly connect?: ExecSessionOptions['connect'];
  readonly reattachWindowMs?: number;
  readonly reattachDelayMs?: number;

  // must not wake the imp
  readonly isAttachedElsewhere?: (imp: string, session: string) => Promise<boolean>;
  readonly printError?: (line: string) => void;
  readonly now?: () => number;
  readonly wait?: (durationMs: number) => Promise<void>;
}

const IMP_FAILED_CODE = 255;
const CTRL_C = 0x03;
const HANDLED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;

// impd restarts in seconds, and a wake takes less than one
const REATTACH_WINDOW_MS = 60_000;
const REATTACH_DELAY_MS = 1000;
const MAX_PENDING_INPUT = 64 * 1024;
const CLEAR_SCREEN = '\u001B[H\u001B[2J';

export function createExecIO(io: CommandIO): ExecIo {
  return {
    env: io.env,
    stdin: io.openStdin(),
    writeOutput: (fd, data) => {
      if (fd === 1) {
        io.writeOut(data);
      } else {
        io.writeErr(data);
      }
    },
    printError: io.printError,
  };
}

export function runExec(
  options: Readonly<ExecOptions>,
  io: ExecIo = createExecIO(readProcessIO()),
): Promise<number> {
  const printError = io.printError ?? console.error;
  const now = io.now ?? Date.now;
  const wait = io.wait ?? Bun.sleep;
  let config: CliConfig;

  try {
    config = loadCliConfig(io.env, options.host, printError);
  } catch (error) {
    printError(`impz: ${error instanceof Error ? error.message : String(error)}`);

    return Promise.resolve(IMP_FAILED_CODE);
  }

  const stdin = io.stdin;
  const session = options.session ?? null;
  const isRaw = options.tty && stdin.isTTY === true;

  const encoder = new TextEncoder();

  const modes = createModeWatcher();
  const done = Promise.withResolvers<number>();

  const state = {
    ended: false,
    raw: false,
    signalled: false,
    draining: false,
    stdinStarted: false,

    pendingInput: [] as Uint8Array[],
    pendingBytes: 0,
  };

  let machine: ExecMachine = {
    imp: options.name,
    session: session?.name ?? null,
    config,
    windowMs: io.reattachWindowMs ?? REATTACH_WINDOW_MS,
    firstDelayMs: io.reattachDelayMs ?? REATTACH_DELAY_MS,
    started: false,
    reattachUntil: null,
    tries: 0,
  };

  const advance = (event: ExecEvent): ExecStep => {
    const transition = advanceExec(machine, event);

    machine = transition.machine;

    return transition.step;
  };

  const isAway = (): boolean => machine.reattachUntil !== null;

  const writeNotice = (text: string): void => {
    io.writeOutput(2, encoder.encode(`${isRaw ? '\r\n' : ''}impz: ${text}\r\n`));
  };

  const openSession = (attach: boolean): ExecSession => {
    const size = options.tty ? readTerminalSize() : null;

    const start =
      attach && session !== null
        ? { name: options.name, session: session.name, ...size }
        : {
            name: options.name,
            argv: options.argv,
            tty: options.tty,
            ...(options.env !== undefined && { env: { ...options.env } }),
            ...(session !== null && { session: session.name }),
            ...(session?.log === true && { log: true }),
            ...(options.outer === true && { outer: true }),
            ...(options.require !== undefined && { require: options.require }),
            ...size,
          };

    return openExecSession({
      baseUrl: config.url,
      token: config.token,
      start,
      onStarted: (started) => {
        const step = advance({ kind: 'started' });
        const wasAway = step.kind === 'attached' && step.wasAway;

        if (isRaw && !started.created && started.session !== null) {
          io.writeOutput(1, encoder.encode(CLEAR_SCREEN));
        }

        if (wasAway) {
          writeNotice(`attached again to session ${started.session ?? ''}`);
          sendPendingInput();
        }

        startStdin();
      },
      onOutput: (channel, data) => {
        if (isRaw) {
          modes.observe(data);
        }

        const fd = channel === 'stderr' ? 2 : 1;

        io.writeOutput(fd, data);
      },
      connect: io.connect ?? openBunWebSocket,
    });
  };

  const current = { session: openSession(session?.attachOnly ?? false) };

  // runs on process.exit too, so no exit path leaves the terminal raw or in
  // a program's modes
  const resetTerminal = (): void => {
    if (!state.raw) {
      return;
    }

    state.raw = false;

    // raw mode first: a write that throws or exits must not leave it on
    stdin.setRawMode?.(false);

    try {
      io.writeOutput(1, encoder.encode(modes.buildReset()));
    } catch {
      // the terminal went away; nothing to reset
    }
  };

  const sendResize = (): void => {
    const size = readTerminalSize();

    if (size !== null) {
      current.session.resize(size.cols, size.rows);
    }
  };

  const signalHandlers = HANDLED_SIGNALS.map((signal) => {
    const handleSignal = (): void => {
      // a hangup or a kill detaches from a session, which outlives the CLI;
      // before the start, impd would only queue the signal
      if (session !== null || !current.session.isStarted() || state.signalled) {
        stopSession(toSignalExitCode(signal) ?? IMP_FAILED_CODE);

        return;
      }

      state.signalled = true;

      current.session.sendSignal(signal);
    };

    return [signal, handleSignal] as const;
  });

  const handleDetachKey = (): void => {
    stopSession(0);
    printError(`impz: detached from ${formatSession(machine)}`);
  };

  const sendStdin = (chunk: Uint8Array): void => {
    const key = isRaw && session !== null ? session.detachKey : null;
    const found = key === null ? null : findDetachKey(chunk, key);
    const before = found === null ? chunk : chunk.subarray(0, found.at);

    if (isAway()) {
      holdInput(before);
    } else if (before.byteLength > 0) {
      sendInput(before);
    }

    if (found !== null && !state.ended) {
      handleDetachKey();
    }
  };

  const sendInput = (data: Uint8Array): void => {
    if (current.session.sendStdin(data) || state.draining) {
      return;
    }

    void waitAndResume();
  };

  const holdInput = (data: Uint8Array): void => {
    if (isRaw && data.includes(CTRL_C)) {
      stopSession(toSignalExitCode('SIGINT') ?? IMP_FAILED_CODE);

      return;
    }

    if (state.pendingBytes + data.byteLength > MAX_PENDING_INPUT) {
      return;
    }

    state.pendingInput.push(new Uint8Array(data));

    state.pendingBytes += data.byteLength;
  };

  const sendPendingInput = (): void => {
    const pending = state.pendingInput;

    state.pendingInput = [];
    state.pendingBytes = 0;

    for (const data of pending) {
      sendInput(data);
    }
  };

  const waitAndResume = async (): Promise<void> => {
    const waiting = current.session;

    state.draining = true;

    stdin.pause();

    await waiting.waitForDrain();

    if (state.ended || current.session !== waiting || isAway()) {
      return;
    }

    state.draining = false;

    stdin.resume();
  };

  const sendStdinEof = (): void => {
    current.session.closeStdin();
  };

  // a terminal on stdin is read only with a tty, as `docker exec` without -i
  // does
  const startStdin = (): void => {
    if (state.stdinStarted) {
      return;
    }

    state.stdinStarted = true;

    if (stdin.isTTY === true && !options.tty) {
      current.session.closeStdin();

      return;
    }

    if (isRaw) {
      stdin.setRawMode?.(true);
      state.raw = true;

      process.on('SIGWINCH', sendResize);
    }

    stdin.on('data', sendStdin);
    stdin.on('end', sendStdinEof);
    stdin.resume();
  };

  const stopSession = (code: number): void => {
    if (state.ended) {
      return;
    }

    state.ended = true;

    resetTerminal();

    process.off('exit', resetTerminal);
    process.off('SIGWINCH', sendResize);

    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }

    stdin.off('data', sendStdin);
    stdin.off('end', sendStdinEof);
    stdin.pause();
    current.session.stop();
    done.resolve(code);
  };

  process.on('exit', resetTerminal);

  for (const [signal, handler] of signalHandlers) {
    process.on(signal, handler);
  }

  const isAttachedElsewhere = io.isAttachedElsewhere ?? createAttachedCheck(config);

  const stopWith = (step: Extract<ExecStep, { kind: 'stop' }>): void => {
    stopSession(step.code);

    if (step.message !== null) {
      printError(`impz: ${step.message}`);
    }
  };

  // a terminal that was away must not take the session from a newer one
  const runAttach = async (attempt: number): Promise<void> => {
    if (attempt > 1) {
      const elsewhere = state.ended
        ? false
        : await isAttachedElsewhere(options.name, machine.session ?? '');

      if (state.ended) {
        return;
      }

      if (elsewhere) {
        stopWith(requireStop(advance({ kind: 'taken_over' })));

        return;
      }

      current.session = openSession(true);
    }

    const outcome = await current.session.outcome;

    if (state.ended) {
      return;
    }

    const step = advance({ kind: 'outcome', outcome, now: now() });

    if (step.kind !== 'reattach') {
      stopWith(requireStop(step));

      return;
    }

    if (step.isFirst) {
      if (state.draining) {
        state.draining = false;

        stdin.resume();
      }

      writeNotice(`lost the connection to session ${machine.session ?? ''}; attaching again`);
    }

    throw new SessionAwayError(step.delayMs);
  };

  const waitForOutcome = async (): Promise<void> => {
    try {
      await pRetry(runAttach, {
        retries: Number.POSITIVE_INFINITY,
        minTimeout: 0,
        // oxlint-disable-next-line zgeoff/verb-contract -- p-retry's option name
        shouldRetry: async (context) => {
          if (!(context.error instanceof SessionAwayError)) {
            return false;
          }

          // the pause is the CLI's own, so a test drives its clock
          await wait(context.error.delayMs);

          return true;
        },
      });
    } catch (error) {
      stopSession(IMP_FAILED_CODE);
      printError(`impz: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  void waitForOutcome();

  return done.promise;
}

class SessionAwayError extends Error {
  override name = 'SessionAwayError';

  readonly delayMs: number;

  constructor(delayMs: number) {
    super('the session is away');

    this.delayMs = delayMs;
  }
}

function requireStop(step: ExecStep): Extract<ExecStep, { kind: 'stop' }> {
  if (step.kind !== 'stop') {
    throw new Error(`advanceExec gave ${step.kind} where it ends the exec`);
  }

  return step;
}

// impd's session list never wakes the imp; when impd cannot answer, the
// attach itself finds out
function createAttachedCheck(
  config: CliConfig,
): (imp: string, session: string) => Promise<boolean> {
  return async (imp, session) => {
    try {
      const sessions = await createImpClient(config).sessions.list({ name: imp });

      return sessions.some((entry) => entry.name === session && entry.attached);
    } catch {
      return false;
    }
  };
}

// a pty nobody sized reports 0 columns and 0 rows
function readTerminalSize(): { cols: number; rows: number } | null {
  const cols = process.stdout.columns;
  const rows = process.stdout.rows;

  return process.stdout.isTTY && cols > 0 && rows > 0 ? { cols, rows } : null;
}
