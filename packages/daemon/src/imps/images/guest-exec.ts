import type { StartTimer } from '../../platform/process/clock';
import { startRealTimer } from '../../platform/process/start-real-timer';
import type { AgentExecRequest, ExecStream } from '../../vm/agent-client/exec-stream';

const STDOUT_MAX_BYTES = 1024 ** 2;
const STDERR_TAIL_BYTES = 64 * 1024;
const SIGKILL = 9;

interface GuestRun {
  readonly exitCode: number;
  readonly stdout: string;

  readonly stderr: string;
}

interface GuestRunOptions {
  readonly stdinPath?: string;

  readonly onStdout?: (chunk: Uint8Array) => Promise<void>;

  readonly onStderr?: (chunk: Uint8Array) => void;

  readonly timeoutMs?: number;
  readonly signal: AbortSignal;
}

export type GuestExec = (argv: readonly string[], options: GuestRunOptions) => Promise<GuestRun>;

export class GuestOutputError extends Error {
  override readonly name = 'GuestOutputError';
}

export function createGuestExec(
  open: (request: AgentExecRequest) => Promise<ExecStream>,
  startTimer: StartTimer = startRealTimer,
): GuestExec {
  return async (argv, options) => {
    options.signal.throwIfAborted();

    const stream = await open({ argv: [...argv], tty: false, user: '0' });

    if (options.signal.aborted) {
      stream.close();
      options.signal.throwIfAborted();
    }

    const stopStep = () => {
      stream.sendSignal(SIGKILL);
      stream.close();
    };

    options.signal.addEventListener('abort', stopStep, { once: true });

    const timeout = { hit: false };

    const cancelTimeout =
      options.timeoutMs === undefined
        ? () => {}
        : startTimer(() => {
            timeout.hit = true;

            stopStep();
          }, options.timeoutMs);

    try {
      // docker build writes its log while it reads the context from stdin, so stdin is sent
      // beside the event loop rather than before it.
      const sending =
        options.stdinPath === undefined
          ? Promise.resolve(null)
          : sendStdin(stream, options.stdinPath, options.signal);

      const stdout: Uint8Array[] = [];
      const stderr = createTail(STDERR_TAIL_BYTES);
      const kept = { bytes: 0 };

      const collectStdout = (data: Uint8Array): Promise<void> => {
        kept.bytes += data.byteLength;

        if (kept.bytes > STDOUT_MAX_BYTES) {
          throw new GuestOutputError(
            `${argv.join(' ')}: wrote more than ${String(STDOUT_MAX_BYTES)} bytes`,
          );
        }

        stdout.push(data);

        return Promise.resolve();
      };

      const takeStdout = options.onStdout ?? collectStdout;

      for await (const event of stream.events()) {
        if (event.type === 'stderr') {
          stderr.writeChunk(event.data);
          options.onStderr?.(event.data);
        } else if (event.type === 'stdout') {
          await takeStdout(event.data);
        } else if (event.type === 'exit') {
          const sendError = await sending;

          if (sendError !== null) {
            throw sendError;
          }

          options.signal.throwIfAborted();

          return {
            exitCode: event.signal === 0 ? event.code : 128 + event.signal,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: stderr.readText(),
          };
        }
      }

      options.signal.throwIfAborted();

      if (timeout.hit) {
        throw new Error(`${argv.join(' ')}: no exit in ${String(options.timeoutMs)} ms`);
      }

      throw new Error(`${argv.join(' ')}: the builder's agent closed the exec before its exit`);
    } finally {
      cancelTimeout();

      options.signal.removeEventListener('abort', stopStep);
      stream.close();
    }
  };
}

async function sendStdin(
  stream: Readonly<ExecStream>,
  path: string,
  signal: AbortSignal,
): Promise<Error | null> {
  try {
    for await (const chunk of Bun.file(path).stream() as AsyncIterable<Uint8Array>) {
      signal.throwIfAborted();
      stream.writeStdin(chunk);

      await stream.stdinDrained();
    }

    stream.closeStdin();

    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function createTail(maxBytes: number) {
  const chunks: Uint8Array[] = [];
  const held = { bytes: 0 };

  return {
    writeChunk: (chunk: Uint8Array): void => {
      chunks.push(chunk);

      held.bytes += chunk.byteLength;

      while (held.bytes - (chunks[0]?.byteLength ?? 0) >= maxBytes) {
        held.bytes -= chunks.shift()?.byteLength ?? 0;
      }
    },
    readText: (): string => Buffer.concat(chunks).toString('utf8').slice(-maxBytes),
  };
}
