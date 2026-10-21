import type { Socket } from 'node:net';
import type { MessageInitShape } from '@bufbuild/protobuf';
import {
  DetachedSchema,
  ErrorResponseSchema,
  ExitSchema,
  FRAME_TYPES,
  RequestSchema,
  ResizeSchema,
  SignalSchema,
  StartedSchema,
  decodeMessageFrame,
  encodeFrame,
  encodeMessageFrame,
} from '@impz/agent-protocol';
import type { AgentFrame, ErrorSchema, Request } from '@impz/agent-protocol';
import type { StubAgentHandler } from '@impz/daemon/testing';

interface Run {
  readonly command: string;
  ended: boolean;
}

export function buildStubExecAgent() {
  const requests: Request[] = [];
  const input: string[] = [];
  const closed: string[] = [];

  const runs = new WeakMap<Socket, Run>();

  const writeInput = (entry: string): void => {
    input.push(entry);
  };

  const readFrame: StubAgentHandler = (socket, request, frames) => {
    const known = runs.get(socket);

    if (known !== undefined) {
      if (!known.ended) {
        readInput(socket, known, frames.at(-1) ?? request, writeInput);
      }

      return;
    }

    const parsed = decodeMessageFrame(RequestSchema, request);

    const command =
      parsed.op === 'session.attach' ? `attach ${String(parsed.session)}` : (parsed.argv[0] ?? '');

    const run: Run = { command, ended: false };

    runs.set(socket, run);
    requests.push(parsed);

    // impd may close the connection while a command still writes, as it does
    // for a client that stopped reading.
    socket.on('error', () => {});

    socket.on('close', () => {
      if (!run.ended) {
        closed.push(command);
      }
    });

    if (parsed.op === 'exec') {
      startExec(socket, run, parsed);
    } else if (parsed.op === 'session.attach') {
      startAttach(socket, run, parsed);
    } else {
      sendRefusal(socket, run, { code: 'UNKNOWN_OP', message: `unknown op ${parsed.op}` });
    }
  };

  return { requests, input, closed, readFrame };
}

const decoder = new TextDecoder();

function readInput(
  socket: Socket,
  run: Run,
  frame: AgentFrame,
  writeInput: (entry: string) => void,
) {
  if (frame.type === FRAME_TYPES.stdin) {
    const text = decoder.decode(frame.payload);

    writeInput(text);

    if (run.command === 'cat') {
      socket.write(encodeFrame(FRAME_TYPES.stdout, frame.payload));
    }

    if ((run.command === 'wait' || run.command === '/bin/sh') && text.includes('\u0003')) {
      sendExit(socket, run, 130, 2);
    }

    if (run.command === 'attach main' && text === 'taken') {
      stopRun(
        socket,
        run,
        encodeMessageFrame(FRAME_TYPES.detached, DetachedSchema, { reason: 'taken_over' }),
      );
    }
  }

  if (frame.type === FRAME_TYPES.stdinEof) {
    writeInput('eof');

    if (run.command === 'cat') {
      sendExit(socket, run, 0, 0);
    }
  }

  if (frame.type === FRAME_TYPES.resize) {
    const size = decodeMessageFrame(ResizeSchema, frame);

    writeInput(`resize:${String(size.cols)}x${String(size.rows)}`);
  }

  if (frame.type === FRAME_TYPES.signal) {
    const signal = decodeMessageFrame(SignalSchema, frame).signal;

    writeInput(`signal:${String(signal)}`);
    sendExit(socket, run, 128 + signal, signal);
  }
}

function sendExit(socket: Socket, run: Run, code: number, signal: number): void {
  stopRun(socket, run, encodeMessageFrame(FRAME_TYPES.exit, ExitSchema, { code, signal }));
}

function stopRun(socket: Socket, run: Run, frame: Uint8Array): void {
  run.ended = true;

  socket.end(frame);
}

export const STUB_FLOOD_BYTES = 512 * 1024;

function startExec(socket: Socket, run: Run, request: Request): void {
  if (run.command === 'nope') {
    sendRefusal(socket, run, { code: 'EXEC_FAILED', message: 'no such file' });

    return;
  }

  const groupKill = request.killGraceMs !== undefined && run.command !== 'old';

  socket.write(
    encodeMessageFrame(FRAME_TYPES.started, StartedSchema, {
      pid: 42,
      ...(request.session !== undefined && { session: request.session, created: true }),
      ...(groupKill && { killGraceMs: request.killGraceMs }),
    }),
  );

  if (run.command === 'fail') {
    writeText(socket, FRAME_TYPES.stdout, 'out');
    writeText(socket, FRAME_TYPES.stderr, 'err');
    sendExit(socket, run, 3, 0);
  }

  if (run.command === 'tick') {
    writeText(socket, FRAME_TYPES.stdout, 'tick');
  }

  if (run.command === 'big') {
    for (let sent = 0; sent < STUB_FLOOD_BYTES; sent += 16_384) {
      socket.write(encodeFrame(FRAME_TYPES.stdout, new Uint8Array(16_384).fill(111)));
      socket.write(encodeFrame(FRAME_TYPES.stderr, new Uint8Array(16_384).fill(101)));
    }

    sendExit(socket, run, 0, 0);
  }
}

function sendRefusal(socket: Socket, run: Run, error: MessageInitShape<typeof ErrorSchema>): void {
  stopRun(socket, run, encodeMessageFrame(FRAME_TYPES.response, ErrorResponseSchema, { error }));
}

const encoder = new TextEncoder();

function writeText(socket: Socket, type: 8 | 9, text: string): void {
  socket.write(encodeFrame(type, encoder.encode(text)));
}

export const STUB_BOOT_ID = '6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
const OUTPUT_END = 100;

export const STUB_GENERATION = 'd'.repeat(32);

function startAttach(socket: Socket, run: Run, request: Request): void {
  if ((request.resumeFrom?.offset ?? 0) > OUTPUT_END) {
    sendRefusal(socket, run, {
      code: 'INVALID_RESUME',
      message: 'past the end',
      data: { end: OUTPUT_END, bufferStart: 0 },
    });

    return;
  }

  if (request.session === 'counted') {
    socket.write(
      encodeMessageFrame(FRAME_TYPES.started, StartedSchema, {
        pid: 42,
        session: 'counted',
        created: false,
        output: {
          bootId: STUB_BOOT_ID,
          executionGeneration: STUB_GENERATION,
          bufferStart: 0,
          end: OUTPUT_END,
          offset: 95,
          prelude: 0,
          resume: { kind: 'exact' },
        },
      }),
    );

    writeText(socket, FRAME_TYPES.stdout, 'tail!');
    sendExit(socket, run, 0, 0);

    return;
  }

  if (request.session === 'ended') {
    sendRefusal(socket, run, {
      code: 'NO_SESSION',
      message: 'no session "ended"',
      data: {
        bootId: STUB_BOOT_ID,
        previous: {
          executionGeneration: STUB_GENERATION,
          end: OUTPUT_END,
          exit: { code: 0, signal: 0 },
        },
      },
    });

    return;
  }

  if (request.session !== 'main') {
    sendRefusal(socket, run, {
      code: 'NO_SESSION',
      message: `no session "${String(request.session)}"`,
    });

    return;
  }

  socket.write(
    encodeMessageFrame(FRAME_TYPES.started, StartedSchema, {
      pid: 42,
      session: 'main',
      created: false,
    }),
  );

  writeText(socket, FRAME_TYPES.stdout, 'replay');
}
