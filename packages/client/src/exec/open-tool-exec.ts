import {
  EXEC_CHANNELS,
  EXEC_MAX_STDIN_FRAME_BYTES,
  EXEC_PATH,
  EXEC_STDIN_WINDOW_BYTES,
  ExecServerMessageSchema,
  decodeExecFrame,
  encodeExecFrame,
} from '@impz/api';
import type { ExecClientMessage, ExecServerMessage, ExecTool } from '@impz/api';
import { match } from 'ts-pattern';
import { resolveImpdWebSocketUrl } from '../resolve-impd-web-socket-url';
import type { ExecSocket } from './open-exec-session';

export interface ToolExec {
  readonly writeStdin: (data: Uint8Array) => Promise<void>;
  readonly endStdin: () => void;
  readonly waitExit: () => Promise<number>;
  readonly close: () => void;
}

export interface ToolExecOptions {
  readonly baseUrl: string;
  readonly token: string | null;
  readonly name: string;
  readonly tool: ExecTool;
  readonly args: readonly string[];
  readonly onStdout: (data: Uint8Array) => Promise<void>;
  readonly onStderr: (data: Uint8Array) => void;

  // A tool exec needs the bearer header, which a browser WebSocket cannot send.
  readonly connect: (url: string, headers: Readonly<Record<string, string>>) => ExecSocket;
}

class ToolExecError extends Error {
  override name = 'ToolExecError';
}

interface AckWaiter {
  wake: (() => void) | null;
}

type ExecOutcome = { readonly code: number } | { readonly error: Error };

export async function openToolExec(options: ToolExecOptions): Promise<ToolExec> {
  const headers: Record<string, string> =
    options.token === null ? {} : { authorization: `Bearer ${options.token}` };

  const ws = options.connect(resolveImpdWebSocketUrl(options.baseUrl, EXEC_PATH).href, headers);
  const started = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<ExecOutcome>();
  const waiter: AckWaiter = { wake: null };
  const state = { unacked: 0, done: false };

  ws.binaryType = 'arraybuffer';

  const sendStdoutAck = async (data: Uint8Array): Promise<void> => {
    await options.onStdout(data);

    if (data.byteLength > 0 && ws.readyState === WebSocket.OPEN) {
      const ack: ExecClientMessage = { type: 'stdout_ack', bytes: data.byteLength };

      ws.send(JSON.stringify(ack));
    }
  };

  const stopWithError = (error: Error): void => {
    state.done = true;

    started.reject(error);
    exited.resolve({ error });
    waiter.wake?.();
  };

  const handleControl = (message: ExecServerMessage): void => {
    match(message)
      .with({ type: 'started' }, () => {
        started.resolve();
      })
      .with({ type: 'stdin_ack' }, (ack) => {
        state.unacked -= ack.bytes;
        waiter.wake?.();
      })
      .with({ type: 'exit' }, (exit) => {
        state.done = true;

        exited.resolve({ code: exit.code ?? 1 });
        waiter.wake?.();
      })
      .with({ type: 'error' }, (failure) => {
        stopWithError(new ToolExecError(`${failure.code ?? 'error'}: ${failure.message}`));
      })
      .with({ type: 'detached' }, () => {
        stopWithError(new ToolExecError('impd detached a tool exec'));
      })
      .exhaustive();
  };

  ws.addEventListener('open', () => {
    const start: ExecClientMessage = {
      type: 'start',
      name: options.name,
      tool: options.tool,
      argv: [...options.args],
      tty: false,
    };

    ws.send(JSON.stringify(start));
  });

  ws.addEventListener('message', (event) => {
    if (event.data instanceof ArrayBuffer) {
      const frame = decodeExecFrame(new Uint8Array(event.data));

      if (frame.channel === EXEC_CHANNELS.stdout) {
        void sendStdoutAck(frame.data);
      } else if (frame.channel === EXEC_CHANNELS.stderr) {
        options.onStderr(frame.data);
      }

      return;
    }

    const message = parseServerMessage(String(event.data));

    if (message === null) {
      stopWithError(new ToolExecError('impd sent a message the client does not know'));

      ws.close();
    } else {
      handleControl(message);
    }
  });

  ws.addEventListener('close', () => {
    if (!state.done) {
      stopWithError(new ToolExecError(`the connection to impd at ${options.baseUrl} closed`));
    }
  });

  // The error event carries no detail, and a close event follows it.
  ws.addEventListener('error', () => {});

  await started.promise;

  const waitForWindow = async (): Promise<void> => {
    while (!state.done && state.unacked > EXEC_STDIN_WINDOW_BYTES) {
      await new Promise<void>((resolve) => {
        waiter.wake = resolve;
      });

      waiter.wake = null;
    }
  };

  return {
    writeStdin: async (data) => {
      for (let offset = 0; offset < data.byteLength; offset += EXEC_MAX_STDIN_FRAME_BYTES) {
        await waitForWindow();

        if (state.done) {
          return;
        }

        const slice = data.subarray(offset, offset + EXEC_MAX_STDIN_FRAME_BYTES);

        ws.send(encodeExecFrame(EXEC_CHANNELS.stdin, slice));

        state.unacked += slice.byteLength;
      }
    },
    endStdin: () => {
      if (!state.done) {
        ws.send(JSON.stringify({ type: 'stdin_eof' } satisfies ExecClientMessage));
      }
    },
    waitExit: async () => {
      const outcome = await exited.promise;

      if ('error' in outcome) {
        throw outcome.error;
      }

      return outcome.code;
    },
    close: () => {
      state.done = true;

      ws.close();
    },
  };
}

function parseServerMessage(text: string): ExecServerMessage | null {
  try {
    const parsed = ExecServerMessageSchema.safeParse(JSON.parse(text));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
