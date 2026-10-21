import { isMessage } from '@bufbuild/protobuf';
import {
  DetachedSchema,
  ErrorDataSchema,
  ExitSchema,
  FRAME_TYPES,
  ResizeSchema,
  SignalSchema,
  StartedSchema,
  decodeMessageFrame,
  encodeAgentMessage,
} from '@impz/agent-protocol';
import type { Previous, Resume, Started } from '@impz/agent-protocol';
import type {
  ExecRequirement,
  PreviousGeneration,
  ResumeFrom,
  ResumeResult,
  SessionOutput,
} from '@impz/api';
import { AgentError, openAgentConnection } from './agent-connection';
import type { AgentConnection } from './agent-connection';
import { buildAgentOutdatedError, handleUnknownOp } from './agent-outdated';
import { readFrameWithin, requireNoAgentError, sendRequestFrame } from './agent-requests';
import type { AgentRequest } from './agent-requests';
import { hasAgentNameForms } from './has-agent-name-forms';

export interface AgentExecRequest {
  readonly argv: readonly string[];
  readonly env?: readonly string[];
  readonly cwd?: string;
  readonly tty: boolean;
  readonly cols?: number;
  readonly rows?: number;
  readonly user?: string;
  readonly session?: string;
  readonly killGraceMs?: number;
  readonly resumeFrom?: ResumeFrom;
  readonly log?: boolean;
  readonly outer?: boolean;

  // An agent before 0.20.0 ignores this field, so a caller checks the agent's version first.
  readonly dropSysAdmin?: boolean;
  readonly require?: readonly ExecRequirement[];
}

export interface AgentAttachRequest {
  readonly session: string;
  readonly cols?: number;
  readonly rows?: number;
  readonly resumeFrom?: ResumeFrom;
  readonly wake?: boolean;
}

export type ExecEvent =
  | { readonly type: 'stdout' | 'stderr'; readonly data: Uint8Array }
  | { readonly type: 'exit'; readonly code: number; readonly signal: number }
  | { readonly type: 'detached'; readonly reason: string };

export interface ExecStream {
  readonly pid: number;
  readonly session: string | null;
  readonly created: boolean;
  readonly groupKill: boolean;
  readonly output: SessionOutput | null;
  readonly writeStdin: (data: Uint8Array) => void;
  readonly stdinDrained: () => Promise<void>;
  readonly closeStdin: () => void;
  readonly resize: (cols: number, rows: number) => void;
  readonly sendSignal: (signal: number) => void;
  readonly events: () => AsyncGenerator<ExecEvent, void, undefined>;
  readonly close: () => void;
}

const EXEC_START_TIMEOUT_MS = 10_000;

export async function openExecStream(
  vsockPath: string,
  request: Readonly<AgentExecRequest>,
  startTimeoutMs = EXEC_START_TIMEOUT_MS,
): Promise<ExecStream> {
  const { argv, env, resumeFrom, outer, require: _checked, ...rest } = request;
  const op = outer === true ? 'exec.outer' : 'exec';

  const opening = openStream(
    vsockPath,
    {
      op,
      ...rest,
      argv: [...argv],
      ...(env !== undefined && { env: [...env] }),
      ...(resumeFrom !== undefined && { resumeFrom }),
    },
    startTimeoutMs,
  );

  const stream = await (outer === true ? opening.catch(handleUnknownOp('outer-exec')) : opening);

  // An agent from before sessions ignores the name and runs a plain exec, which would die with its
  // connection.
  if (request.session !== undefined && stream.session === null) {
    stream.close();
    throw buildAgentOutdatedError('sessions');
  }

  return stream;
}

export function openTapStream(
  vsockPath: string,
  session: string,
  resumeFrom?: ResumeFrom,
  startTimeoutMs = EXEC_START_TIMEOUT_MS,
): Promise<ExecStream> {
  return openStream(
    vsockPath,
    {
      op: 'session.tap',
      session,
      ...(resumeFrom !== undefined && { resumeFrom }),
    },
    startTimeoutMs,
  ).catch(handleUnknownOp('session-log'));
}

export function openAttachStream(
  vsockPath: string,
  request: Readonly<AgentAttachRequest>,
  startTimeoutMs = EXEC_START_TIMEOUT_MS,
): Promise<ExecStream> {
  const { resumeFrom, wake: _wake, ...rest } = request;

  return openStream(
    vsockPath,
    {
      op: 'session.attach',
      ...rest,
      ...(resumeFrom !== undefined && { resumeFrom }),
    },
    startTimeoutMs,
  ).catch(handleUnknownOp('sessions'));
}

async function openStream(
  vsockPath: string,
  request: AgentRequest,
  startTimeoutMs: number,
): Promise<ExecStream> {
  const connection = await openAgentConnection(vsockPath);

  let started: Started;
  let output: SessionOutput | null;

  try {
    sendRequestFrame(connection, request);

    const first = await readFrameWithin(connection, startTimeoutMs);

    if (first === null) {
      throw new Error('agent closed the exec connection before the process started');
    }

    requireNoAgentError(first);

    if (first.type !== FRAME_TYPES.started) {
      throw new Error(`agent exec: expected STARTED, got frame type ${String(first.type)}`);
    }

    started = decodeMessageFrame(StartedSchema, first);

    if (!hasAgentNameForms(started)) {
      throw new Error(
        'agent exec: STARTED names a session, generation or boot the agent never makes',
      );
    }

    output = toSessionOutput(started);
  } catch (error) {
    connection.close();
    throw toApiAgentError(error);
  }

  return {
    pid: started.pid,
    session: started.session ?? null,
    created: started.created ?? false,
    groupKill: (started.killGraceMs ?? 0) > 0,
    output,
    writeStdin: (data) => {
      connection.send(FRAME_TYPES.stdin, data);
    },
    stdinDrained: connection.drained,
    closeStdin: () => {
      connection.send(FRAME_TYPES.stdinEof);
    },
    resize: (cols, rows) => {
      connection.sendJson(FRAME_TYPES.resize, encodeAgentMessage(ResizeSchema, { cols, rows }));
    },
    sendSignal: (signal) => {
      connection.sendJson(FRAME_TYPES.signal, encodeAgentMessage(SignalSchema, { signal }));
    },
    events: () => readExecEvents(connection),
    close: connection.close,
  };
}

async function* readExecEvents(
  connection: AgentConnection,
): AsyncGenerator<ExecEvent, void, undefined> {
  for (;;) {
    const frame = await connection.next();

    if (frame === null) {
      return;
    }

    if (frame.type === FRAME_TYPES.stdout || frame.type === FRAME_TYPES.stderr) {
      const type = frame.type === FRAME_TYPES.stdout ? 'stdout' : 'stderr';

      yield { type, data: frame.payload };
    } else if (frame.type === FRAME_TYPES.exit) {
      const exit = decodeMessageFrame(ExitSchema, frame);

      yield { type: 'exit', code: exit.code, signal: exit.signal };

      return;
    } else if (frame.type === FRAME_TYPES.detached) {
      const detached = decodeMessageFrame(DetachedSchema, frame);

      yield { type: 'detached', reason: detached.reason };

      return;
    }
  }
}

function toSessionOutput(started: Started): SessionOutput | null {
  if (started.session === undefined) {
    return null;
  }

  const output = started.output;

  if (output === undefined) {
    return { continuity: 'none' };
  }

  return {
    continuity: 'offsets',
    bootId: output.bootId,
    executionGeneration: output.executionGeneration,
    bufferStart: output.bufferStart,
    end: output.end,
    offset: output.offset,
    prelude: output.prelude,
    coldBoots: [],
    ...(output.previous !== undefined && { previous: toPrevious(output.previous) }),
    ...(output.resume !== undefined && { resume: toResume(output.resume) }),
    ...(output.log === true && { log: { enabled: true } }),
  };
}

function toResume(resume: Resume): ResumeResult {
  if (resume.kind === 'exact') {
    return { kind: 'exact' };
  }

  if (resume.kind === 'gap' && resume.from !== undefined && resume.to !== undefined) {
    return { kind: 'gap', from: resume.from, to: resume.to };
  }

  if (
    resume.kind === 'generation_changed' &&
    resume.executionGeneration !== undefined &&
    resume.firstOffset !== undefined
  ) {
    return {
      kind: 'generation_changed',
      executionGeneration: resume.executionGeneration,
      firstOffset: resume.firstOffset,
    };
  }

  throw new Error(`agent exec: a resume of kind ${JSON.stringify(resume.kind)} without its fields`);
}

function toPrevious(previous: Previous): PreviousGeneration {
  const exit = previous.exit ?? { code: 0, signal: 0 };

  return {
    executionGeneration: previous.executionGeneration,
    end: previous.end,
    exitCode: exit.signal === 0 ? exit.code : null,
  };
}

function toApiAgentError(error: unknown): unknown {
  if (!(error instanceof AgentError) || error.data === undefined) {
    return error;
  }

  return new AgentError(error.code, error.detail, toApiErrorData(error.code, error.data));
}

function toApiErrorData(code: string, data: unknown): unknown {
  if (!isMessage(data, ErrorDataSchema) || !hasAgentNameForms(data)) {
    return undefined;
  }

  if (code === 'NO_SESSION' && data.bootId !== undefined) {
    return {
      bootId: data.bootId,
      coldBoots: [],
      ...(data.previous !== undefined && { previous: toPrevious(data.previous) }),
    };
  }

  if (code === 'INVALID_RESUME' && data.end !== undefined && data.bufferStart !== undefined) {
    return { end: data.end, bufferStart: data.bufferStart };
  }

  return undefined;
}
