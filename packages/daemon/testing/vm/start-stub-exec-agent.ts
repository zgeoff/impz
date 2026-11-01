import type { Socket } from 'node:net';
import {
  DetachedSchema,
  ErrorResponseSchema,
  ExitSchema,
  FRAME_TYPES,
  RequestSchema,
  SignalSchema,
  StartedSchema,
  decodeMessageFrame,
  encodeFrame,
  encodeMessageFrame,
} from '@impz/agent-protocol';
import type { AgentFrame, Request } from '@impz/agent-protocol';
import type {
  AgentExecRequest,
  ExecEvent,
  ExecStream,
} from '../../src/vm/agent-client/exec-stream';
import { startStubAgent } from './start-stub-agent';

interface StubExecTarget {
  readonly openExec: (name: string, request: Readonly<AgentExecRequest>) => Promise<ExecStream>;
}

export function startStubExecAgent(path: string, guest: StubExecTarget) {
  const streams = new WeakMap<Socket, Promise<ExecStream>>();

  return startStubAgent(path, (socket, request, frames) => {
    const pending = streams.get(socket);
    const last = frames.at(-1);

    if (pending !== undefined && last !== undefined && frames.length > 1) {
      void sendInput(pending, last);

      return;
    }

    const parsed = decodeMessageFrame(RequestSchema, request);

    if (parsed.op !== 'exec') {
      socket.write(
        encodeMessageFrame(FRAME_TYPES.response, ErrorResponseSchema, {
          error: { code: 'UNKNOWN_OP', message: `unknown op ${parsed.op}` },
        }),
      );

      return;
    }

    const opening = guest.openExec('', {
      argv: parsed.argv,
      tty: parsed.tty ?? false,
      ...(parsed.env.length > 0 && { env: parsed.env }),
      ...(parsed.cwd !== undefined && { cwd: parsed.cwd }),
      ...(parsed.cols !== undefined && { cols: parsed.cols }),
      ...(parsed.rows !== undefined && { rows: parsed.rows }),
      ...(parsed.user !== undefined && { user: parsed.user }),
      ...(parsed.session !== undefined && { session: parsed.session }),
      ...(parsed.killGraceMs !== undefined && { killGraceMs: parsed.killGraceMs }),
    });

    streams.set(socket, opening);

    socket.once('close', () => {
      void stopStream(opening);
    });

    void sendEvents(socket, opening, readKillGraceMs(parsed));
  });
}

async function sendInput(pending: Promise<ExecStream>, frame: AgentFrame): Promise<void> {
  const stream = await pending;

  if (frame.type === FRAME_TYPES.stdin) {
    stream.writeStdin(frame.payload);
  } else if (frame.type === FRAME_TYPES.stdinEof) {
    stream.closeStdin();
  } else if (frame.type === FRAME_TYPES.signal) {
    stream.sendSignal(decodeMessageFrame(SignalSchema, frame).signal);
  }
}

async function stopStream(pending: Promise<ExecStream>): Promise<void> {
  const stream = await pending;

  stream.close();
}

async function sendEvents(
  socket: Socket,
  pending: Promise<ExecStream>,
  killGraceMs: number,
): Promise<void> {
  const stream = await pending;

  socket.write(
    encodeMessageFrame(FRAME_TYPES.started, StartedSchema, {
      pid: stream.pid,
      ...(stream.session !== null && { session: stream.session }),
      ...(stream.session !== null && stream.created && { created: true }),
      ...(stream.groupKill && killGraceMs > 0 && { killGraceMs }),
    }),
  );

  for await (const event of stream.events()) {
    if (!socket.destroyed) {
      socket.write(encodeEventFrame(event));
    }
  }
}

function encodeEventFrame(event: Readonly<ExecEvent>): Uint8Array {
  if (event.type === 'exit') {
    return encodeMessageFrame(FRAME_TYPES.exit, ExitSchema, {
      code: event.code,
      signal: event.signal,
    });
  }

  if (event.type === 'detached') {
    return encodeMessageFrame(FRAME_TYPES.detached, DetachedSchema, { reason: event.reason });
  }

  const type = event.type === 'stdout' ? FRAME_TYPES.stdout : FRAME_TYPES.stderr;

  return encodeFrame(type, event.data);
}

const MAX_KILL_GRACE_MS = 60_000;

function readKillGraceMs(request: Request) {
  if (request.tty === true || request.killGraceMs === undefined || request.killGraceMs <= 0) {
    return 0;
  }

  return Math.min(request.killGraceMs, MAX_KILL_GRACE_MS);
}
