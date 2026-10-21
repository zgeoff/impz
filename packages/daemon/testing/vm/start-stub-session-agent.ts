import { randomBytes } from 'node:crypto';
import type { Socket } from 'node:net';
import type { JsonValue, MessageInitShape } from '@bufbuild/protobuf';
import {
  ActivitySchema,
  DetachedSchema,
  ErrorResponseSchema,
  ExitSchema,
  FRAME_TYPES,
  OKSchema,
  RequestSchema,
  StartedSchema,
  decodeJsonPayload,
  decodeMessageFrame,
  encodeFrame,
  encodeJsonFrame,
  encodeMessageFrame,
} from '@impz/agent-protocol';
import type {
  ErrorSchema,
  PreviousSchema,
  Request,
  ResumeFrom,
  SessionInfoSchema,
} from '@impz/agent-protocol';
import { startStubAgent } from './start-stub-agent';

type StubStart = Readonly<{
  tty?: boolean;
  argv?: readonly string[];
  cols?: number;
  rows?: number;
  log?: boolean;
  resume?: ResumeFrom;
}>;

interface StubExit {
  readonly code: number;
  readonly signal: number;
}

interface StubRun {
  readonly generation: string;
  readonly argv: readonly string[];
  readonly cols: number;
  readonly rows: number;
  readonly isLogged: boolean;
  readonly startedUnixMs: number;
  readonly taps: Set<Socket>;
  output: Buffer;
  viewer: Socket | null;
  exit: StubExit | null;
}

interface StubSessionAgentOptions {
  readonly bootId?: string;

  readonly stack?: Readonly<AsyncDisposableStack>;

  readonly release?: 'before-sessions' | 'before-offsets';
}

const SESSION_OPS: ReadonlySet<string> = new Set(['session.attach', 'session.kill', 'session.tap']);

const HANGUP_EXIT: StubExit = { code: 128 + 1, signal: 1 };

export async function startStubSessionAgent(
  path: string,
  options: Readonly<StubSessionAgentOptions> = {},
) {
  const bootId = options.bootId ?? '6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';

  const runs = new Map<string, StubRun>();
  const previous = new Map<string, MessageInitShape<typeof PreviousSchema>>();

  const connections = { open: 0 };
  const hasOffsets = options.release === undefined;

  const listSessions = (): MessageInitShape<typeof SessionInfoSchema>[] =>
    [...runs]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([name, run]) => ({
        name,
        pid: 9,
        argv: [...run.argv],
        state: run.exit === null ? 'running' : 'exited',
        attached: run.viewer !== null,
        cols: run.cols,
        rows: run.rows,
        startedUnixMs: run.startedUnixMs,
        exit: run.exit ?? undefined,
        executionGeneration: run.generation,
        bootId,
        end: run.output.length,
        log: run.isLogged ? true : undefined,
      }));

  const writeActivity = (socket: Socket): void => {
    if (hasOffsets) {
      socket.write(
        encodeMessageFrame(FRAME_TYPES.response, ActivitySchema, {
          tcpEstablished: 0,
          execSessions: connections.open,
          load1: 0,
          sessions: listSessions(),
        }),
      );

      return;
    }

    // An agent from before sessions or offsets leaves out fields the schema's encoder always
    // writes, so its answer is plain JSON.
    socket.write(
      encodeJsonFrame(FRAME_TYPES.response, {
        tcp_established: 0,
        exec_sessions: connections.open,
        load1: 0,
        ...(options.release === 'before-offsets' && {
          sessions: listSessions().map((session) => ({
            name: session.name,
            pid: session.pid,
            argv: session.argv,
            state: session.state,
            attached: session.attached,
            cols: session.cols,
            rows: session.rows,
            started_unix_ms: session.startedUnixMs,
            exit: session.exit,
          })),
        }),
      }),
    );
  };

  const sendNoSession = (socket: Socket, session: string): void => {
    const last = previous.get(session);

    sendError(socket, {
      code: 'NO_SESSION',
      message: `no session "${session}"`,
      data: { bootId, ...(last !== undefined && { previous: last }) },
    });
  };

  const sendInvalidResume = (socket: Socket, offset: number, end: number): void => {
    sendError(socket, {
      code: 'INVALID_RESUME',
      message: `offset ${String(offset)} is past the end of the output, ${String(end)}`,
      data: { end, bufferStart: 0 },
    });
  };

  const removeRun = (session: string): void => {
    const run = runs.get(session);

    if (run === undefined) {
      return;
    }

    runs.delete(session);

    if (run.exit !== null) {
      previous.set(session, {
        executionGeneration: run.generation,
        end: run.output.length,
        exit: run.exit,
      });
    }
  };

  const sendExit = (session: string, socket: Socket, exit: StubExit): void => {
    socket.end(encodeMessageFrame(FRAME_TYPES.exit, ExitSchema, exit));

    removeRun(session);
  };

  const readPlace = (session: string, resume: ResumeFrom | undefined) => {
    const run = runs.get(session);

    if (run === undefined) {
      throw new Error(`no run of session ${session}`);
    }

    const output = {
      bootId,
      executionGeneration: run.generation,
      bufferStart: 0,
      end: run.output.length,
      offset: 0,
      prelude: 0,
      ...(run.isLogged && { log: true }),
    };

    if (resume === undefined) {
      return output;
    }

    if (resume.executionGeneration !== run.generation) {
      return {
        ...output,
        resume: {
          kind: 'generation_changed',
          executionGeneration: run.generation,
          firstOffset: 0,
        },
      };
    }

    if (resume.offset > run.output.length) {
      return null;
    }

    return { ...output, offset: resume.offset, resume: { kind: 'exact' } };
  };

  const openViewer = (
    socket: Socket,
    session: string,
    resume: ResumeFrom | undefined,
    created: boolean,
  ): void => {
    const run = runs.get(session);

    if (run === undefined) {
      sendNoSession(socket, session);

      return;
    }

    const output = readPlace(session, resume);

    if (output === null) {
      sendInvalidResume(socket, resume?.offset ?? 0, run.output.length);

      return;
    }

    const last = previous.get(session);

    run.viewer?.end(
      encodeMessageFrame(FRAME_TYPES.detached, DetachedSchema, { reason: 'taken_over' }),
    );

    run.viewer = null;

    socket.write(
      encodeMessageFrame(FRAME_TYPES.started, StartedSchema, {
        pid: 9,
        session,
        ...(created && { created: true }),
        ...(hasOffsets && { output: { ...output, ...(last !== undefined && { previous: last }) } }),
      }),
    );

    const data = run.output.subarray(output.offset);

    if (data.length > 0) {
      socket.write(encodeFrame(FRAME_TYPES.stdout, data));
    }

    if (run.exit !== null) {
      sendExit(session, socket, run.exit);

      return;
    }

    run.viewer = socket;

    socket.on('close', () => {
      if (run.viewer === socket) {
        run.viewer = null;
      }
    });
  };

  const startSession = (socket: Socket, session: string, start: StubStart): void => {
    if (start.tty !== true) {
      sendError(socket, { code: 'BAD_REQUEST', message: 'a session needs a tty' });

      return;
    }

    const found = runs.get(session);

    if (
      found !== undefined &&
      (found.exit === null || found.generation === start.resume?.executionGeneration)
    ) {
      openViewer(socket, session, start.resume, false);

      return;
    }

    removeRun(session);

    // The guest agent opens a session at 80 by 24 when either side is unset.
    const isSized = (start.cols ?? 0) > 0 && (start.rows ?? 0) > 0;

    runs.set(session, {
      generation: randomBytes(16).toString('hex'),
      argv: start.argv ?? [],
      cols: isSized ? (start.cols ?? 80) : 80,
      rows: isSized ? (start.rows ?? 24) : 24,
      isLogged: start.log === true,
      startedUnixMs: Date.now(),
      taps: new Set(),
      output: Buffer.alloc(0),
      viewer: null,
      exit: null,
    });

    openViewer(socket, session, start.resume, true);
  };

  const openTap = (socket: Socket, session: string, resume: ResumeFrom | undefined): void => {
    const run = runs.get(session);

    if (run === undefined) {
      sendNoSession(socket, session);

      return;
    }

    if (!run.isLogged) {
      sendError(socket, { code: 'BAD_REQUEST', message: `session "${session}" keeps no log` });

      return;
    }

    const output = readPlace(session, resume);

    if (output === null) {
      sendInvalidResume(socket, resume?.offset ?? 0, run.output.length);

      return;
    }

    socket.write(
      encodeMessageFrame(FRAME_TYPES.started, StartedSchema, { pid: 9, session, output }),
    );

    const data = run.output.subarray(output.offset);

    if (data.length > 0) {
      socket.write(encodeFrame(FRAME_TYPES.stdout, data));
    }

    if (run.exit !== null) {
      socket.end(encodeMessageFrame(FRAME_TYPES.exit, ExitSchema, run.exit));

      return;
    }

    run.taps.add(socket);

    socket.on('close', () => {
      run.taps.delete(socket);
    });
  };

  const stopKilledRun = (socket: Socket, session: string): void => {
    const run = runs.get(session);

    if (run === undefined) {
      sendNoSession(socket, session);

      return;
    }

    if (run.exit === null) {
      run.exit = HANGUP_EXIT;

      for (const reader of [run.viewer, ...run.taps]) {
        reader?.end(encodeMessageFrame(FRAME_TYPES.exit, ExitSchema, HANGUP_EXIT));
      }

      run.viewer = null;

      run.taps.clear();
    }

    removeRun(session);

    socket.end(encodeMessageFrame(FRAME_TYPES.response, OKSchema, { ok: true }));
  };

  const countConnection = (socket: Socket): void => {
    connections.open += 1;

    socket.on('close', () => {
      connections.open -= 1;
    });
  };

  const closeWith = options.stack === undefined ? {} : { stack: options.stack };

  const agent = await startStubAgent(
    path,
    (socket, request, frames) => {
      if (frames.length > 1) {
        return;
      }

      const parsed = decodeMessageFrame(RequestSchema, request);
      const session = parsed.session ?? '';

      if (parsed.op === 'activity') {
        writeActivity(socket);

        return;
      }

      const isUnknown =
        (options.release === 'before-sessions' && SESSION_OPS.has(parsed.op)) ||
        (options.release === 'before-offsets' && parsed.op === 'session.tap');

      if (isUnknown) {
        sendError(socket, { code: 'UNKNOWN_OP', message: `unknown op ${parsed.op}` });

        return;
      }

      if (parsed.op === 'session.kill') {
        stopKilledRun(socket, session);

        return;
      }

      if (parsed.op === 'session.tap') {
        openTap(socket, session, parsed.resumeFrom);

        return;
      }

      countConnection(socket);

      if (parsed.op === 'session.attach') {
        openViewer(socket, session, parsed.resumeFrom, false);

        return;
      }

      if (parsed.session === undefined || options.release === 'before-sessions') {
        socket.write(encodeMessageFrame(FRAME_TYPES.started, StartedSchema, { pid: 9 }));

        return;
      }

      startSession(socket, session, {
        ...(parsed.tty !== undefined && { tty: parsed.tty }),
        argv: parsed.argv,
        ...(parsed.cols !== undefined && { cols: parsed.cols }),
        ...(parsed.rows !== undefined && { rows: parsed.rows }),
        ...(parsed.log !== undefined && { log: parsed.log }),
        ...(parsed.resumeFrom !== undefined && { resume: parsed.resumeFrom }),
      });
    },
    closeWith,
  );

  return {
    close: agent.close,

    readExecs: (): Request[] =>
      agent.received
        .map((frame) => decodeMessageFrame(RequestSchema, frame))
        .filter((frame) => frame.op === 'exec'),

    readExecPayloads: (): JsonValue[] =>
      agent.received
        .map((frame) => decodeJsonPayload(frame))
        .filter((payload) => isExecPayload(payload)),

    readRun: (session: string) => {
      const run = runs.get(session);

      return run === undefined
        ? undefined
        : {
            generation: run.generation,
            state: run.exit === null ? ('running' as const) : ('exited' as const),
            isAttached: run.viewer !== null,
          };
    },

    exitRun: (session: string, exit: StubExit): void => {
      const run = runs.get(session);

      if (run === undefined) {
        throw new Error(`no run of session ${session}`);
      }

      run.exit = exit;

      for (const tapped of run.taps) {
        tapped.end(encodeMessageFrame(FRAME_TYPES.exit, ExitSchema, exit));
      }

      run.taps.clear();

      const viewer = run.viewer;

      run.viewer = null;

      if (viewer !== null && !viewer.destroyed) {
        sendExit(session, viewer, exit);
      }
    },

    writeOutput: (session: string, data: Uint8Array): void => {
      const run = runs.get(session);

      if (run === undefined) {
        throw new Error(`no run of session ${session}`);
      }

      run.output = Buffer.concat([run.output, data]);

      for (const reader of [run.viewer, ...run.taps]) {
        reader?.write(encodeFrame(FRAME_TYPES.stdout, data));
      }
    },

    clearRuns: (): void => {
      runs.clear();
      previous.clear();
    },
  };
}

function sendError(socket: Socket, error: MessageInitShape<typeof ErrorSchema>): void {
  socket.end(encodeMessageFrame(FRAME_TYPES.response, ErrorResponseSchema, { error }));
}

function isExecPayload(payload: JsonValue): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload) &&
    payload['op'] === 'exec'
  );
}
