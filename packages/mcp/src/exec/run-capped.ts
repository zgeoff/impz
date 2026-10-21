import type { ExecHandle, ExecRequirement, ImpClient } from '@impz/client';
import { ExecError } from '@impz/client';
import type { After } from '../after';
import { createOutputCollector } from './output-cap';
import type { CappedOutput } from './output-cap';

export interface CappedRunOptions {
  readonly argv: readonly string[];
  readonly stdin?: Uint8Array;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly require?: readonly ExecRequirement[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly headBytes: number;
  readonly signal: Readonly<AbortSignal>;
  readonly killGraceMs: number;
  readonly after: After;
}

export interface CappedRunResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly stdout: CappedOutput;
  readonly stderr: CappedOutput;
}

export async function runCapped(
  openExec: ImpClient['openExec'],
  name: string,
  options: Readonly<CappedRunOptions>,
): Promise<CappedRunResult> {
  options.signal.throwIfAborted();

  const deadline = new AbortController();

  const stopDeadline = options.after(options.timeoutMs, () => {
    deadline.abort();
  });

  try {
    return await runToStop(openExec, name, options, deadline.signal);
  } finally {
    stopDeadline();
  }
}

async function runToStop(
  openExec: ImpClient['openExec'],
  name: string,
  options: Readonly<CappedRunOptions>,
  deadline: Readonly<AbortSignal>,
): Promise<CappedRunResult> {
  const handle = await openExec(name, options.argv, {
    ...(options.cwd !== undefined && { cwd: options.cwd }),
    ...(options.env !== undefined && { env: options.env }),
    ...(options.require !== undefined && { require: options.require }),
    killGraceMs: options.killGraceMs,
  });

  const stdout = createOutputCollector(options.maxOutputBytes, options.headBytes);
  const stderr = createOutputCollector(options.maxOutputBytes, options.headBytes);

  const reading = Promise.all([
    drain(handle.stdout, stdout.push),
    drain(handle.stderr, stderr.push),
  ]);

  void writeStdin(handle, options.stdin);

  const stop = await waitForStop(handle, [options.signal, deadline]);

  if (stop !== 'exited') {
    await stopCommand(handle, options.killGraceMs, options.after);
  }

  const exit = await readExit(handle, stop);

  await reading;

  if (stop === 'cancel') {
    options.signal.throwIfAborted();
  }

  return {
    exitCode: exit?.code ?? null,
    signal: exit?.signal ?? null,
    timedOut: stop === 'timeout',
    stdout: stdout.finish(),
    stderr: stderr.finish(),
  };
}

async function drain(
  stream: ReadableStream<Uint8Array>,
  push: (chunk: Uint8Array) => void,
): Promise<void> {
  for await (const chunk of stream) {
    push(chunk);
  }
}

async function writeStdin(
  handle: Readonly<ExecHandle>,
  stdin: Uint8Array | undefined,
): Promise<void> {
  try {
    if (stdin !== undefined && stdin.byteLength > 0) {
      await handle.write(stdin);
    }

    await handle.closeStdin();
  } catch {
    // A command that exits before reading its stdin fails the write, and its
    // exit reports why.
  }
}

type Stop = 'exited' | 'timeout' | 'cancel';

async function waitForStop(
  handle: Readonly<ExecHandle>,
  [cancel, deadline]: readonly [Readonly<AbortSignal>, Readonly<AbortSignal>],
): Promise<Stop> {
  const stopped = Promise.withResolvers<Stop>();

  const onCancel = (): void => {
    stopped.resolve('cancel');
  };

  const onDeadline = (): void => {
    stopped.resolve('timeout');
  };

  cancel.addEventListener('abort', onCancel, { once: true });
  deadline.addEventListener('abort', onDeadline, { once: true });

  void (async () => {
    await waitSettled(handle.exit);

    stopped.resolve('exited');
  })();

  try {
    await handle.started;

    if (cancel.aborted) {
      return 'cancel';
    }

    if (deadline.aborted) {
      return 'timeout';
    }

    return await stopped.promise;
  } catch (error) {
    handle.close();
    throw error;
  } finally {
    cancel.removeEventListener('abort', onCancel);
    deadline.removeEventListener('abort', onDeadline);
  }
}

async function waitSettled(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    // the caller reads the outcome where it needs it
  }
}

// A closed exec socket only sends SIGHUP, which nohup ignores, so a stop
// signals the process group. Once its leader exits on SIGTERM, the guest agent
// kills the rest.
async function stopCommand(
  handle: Readonly<ExecHandle>,
  graceMs: number,
  after: After,
): Promise<void> {
  handle.sendSignal('SIGTERM');

  const exited = await waitForExit(handle, graceMs, after);

  if (exited) {
    return;
  }

  handle.sendSignal('SIGKILL');

  const killed = await waitForExit(handle, graceMs, after);

  if (!killed) {
    handle.close();
  }
}

async function waitForExit(
  handle: Readonly<ExecHandle>,
  durationMs: number,
  after: After,
): Promise<boolean> {
  const settled = (async () => {
    await waitSettled(handle.exit);

    return true;
  })();

  const timer = Promise.withResolvers<boolean>();

  const cancel = after(durationMs, () => {
    timer.resolve(false);
  });

  try {
    return await Promise.race([settled, timer.promise]);
  } finally {
    cancel();
  }
}

async function readExit(
  handle: Readonly<ExecHandle>,
  stop: Stop,
): Promise<{ readonly code: number | null; readonly signal: string | null } | null> {
  try {
    return await handle.exit;
  } catch (error) {
    if (stop !== 'exited' && error instanceof ExecError && error.code === 'CLOSED') {
      return null;
    }

    throw error;
  }
}
