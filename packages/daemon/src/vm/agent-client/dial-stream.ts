import { FRAME_TYPES } from '@impz/agent-protocol';
import { openAgentConnection } from './agent-connection';
import type { AgentConnection } from './agent-connection';
import { handleUnknownOp } from './agent-outdated';
import type { AgentFeature } from './agent-outdated';
import { readFrameWithin, requireNoAgentError, sendRequestFrame } from './agent-requests';
import type { AgentRequest } from './agent-requests';

export interface DialTarget {
  readonly network: 'tcp' | 'unix';
  readonly address: string;
}

/* @internal */
export type DialEvent =
  | { readonly type: 'data'; readonly data: Uint8Array }
  | { readonly type: 'eof' };

export interface DialStream {
  readonly write: (data: Uint8Array) => void;
  readonly drained: () => Promise<void>;
  readonly end: () => void;
  readonly events: () => AsyncGenerator<DialEvent, void, undefined>;
  readonly close: () => void;
}

// Longer than the agent's own 5 s connect timeout, so the agent's DIAL_FAILED arrives first.
const DIAL_ANSWER_TIMEOUT_MS = 10_000;

export function openDialStream(
  vsockPath: string,
  target: Readonly<DialTarget>,
  answerTimeoutMs = DIAL_ANSWER_TIMEOUT_MS,
): Promise<DialStream> {
  return openRelayStream(vsockPath, { op: 'dial', ...target }, 'ssh', answerTimeoutMs);
}

export async function openRelayStream(
  vsockPath: string,
  request: AgentRequest,
  feature: AgentFeature,
  answerTimeoutMs: number,
): Promise<DialStream> {
  const connection = await openAgentConnection(vsockPath);

  try {
    sendRequestFrame(connection, request);

    const answer = await readFrameWithin(connection, answerTimeoutMs);

    if (answer?.type !== FRAME_TYPES.response) {
      throw new Error(`agent closed the ${request.op} connection before it answered`);
    }

    requireNoAgentError(answer);
  } catch (error) {
    connection.close();

    return handleUnknownOp(feature)(error);
  }

  return {
    write: (data) => {
      connection.send(FRAME_TYPES.stdin, data);
    },
    drained: connection.drained,
    end: () => {
      connection.send(FRAME_TYPES.stdinEof);
    },
    events: () => readDialEvents(connection),
    close: connection.close,
  };
}

async function* readDialEvents(
  connection: AgentConnection,
): AsyncGenerator<DialEvent, void, undefined> {
  for (;;) {
    const frame = await connection.next();

    if (frame === null) {
      return;
    }

    if (frame.type === FRAME_TYPES.stdout) {
      yield { type: 'data', data: frame.payload };
    } else if (frame.type === FRAME_TYPES.stdoutEof) {
      yield { type: 'eof' };
    }
  }
}
