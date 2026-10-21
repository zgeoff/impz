import {
  ConnectionSchema,
  FRAME_TYPES,
  ListeningSchema,
  decodeMessageFrame,
} from '@impz/agent-protocol';
import { openAgentConnection } from './agent-connection';
import type { AgentConnection } from './agent-connection';
import { handleUnknownOp } from './agent-outdated';
import { readFrameWithin, requireNoAgentError, sendRequestFrame } from './agent-requests';
import type { AgentRequest } from './agent-requests';
import { openRelayStream } from './dial-stream';
import type { DialStream } from './dial-stream';

const ANSWER_TIMEOUT_MS = 10_000;

export type ListenSpec =
  | { readonly network: 'ssh-agent' }
  | { readonly network: 'unix'; readonly path: string | null }
  | { readonly network: 'tcp'; readonly port: number };

export interface GuestListener {
  readonly path: string | null;
  readonly port: number | null;
  readonly id: string;
  readonly connections: () => AsyncGenerator<number, void, undefined>;
  readonly close: () => void;
}

function buildListenRequest(spec: ListenSpec): AgentRequest {
  if (spec.network === 'ssh-agent') {
    return { op: 'agent.listen' };
  }

  if (spec.network === 'unix') {
    return { op: 'listen', network: 'unix', address: spec.path ?? '' };
  }

  return { op: 'listen', network: 'tcp', address: `127.0.0.1:${String(spec.port)}` };
}

export async function openListener(vsockPath: string, spec: ListenSpec): Promise<GuestListener> {
  const feature = spec.network === 'ssh-agent' ? 'agent-forwarding' : 'reverse-forward';

  const connection = await openAgentConnection(vsockPath);

  try {
    sendRequestFrame(connection, buildListenRequest(spec));

    const answer = await readFrameWithin(connection, ANSWER_TIMEOUT_MS);

    if (answer?.type !== FRAME_TYPES.response) {
      throw new Error('agent closed the listen connection before it answered');
    }

    requireNoAgentError(answer);

    const listening = decodeMessageFrame(ListeningSchema, answer);

    return {
      path: listening.path ?? null,
      port: listening.port ?? null,
      id: listening.listener,
      connections: () => readConnections(connection),
      close: connection.close,
    };
  } catch (error) {
    connection.close();

    return handleUnknownOp(feature)(error);
  }
}

export function openAccept(
  vsockPath: string,
  listener: string,
  connection: number,
): Promise<DialStream> {
  return openRelayStream(
    vsockPath,
    { op: 'agent.accept', listener, connection },
    'agent-forwarding',
    ANSWER_TIMEOUT_MS,
  );
}

async function* readConnections(
  connection: AgentConnection,
): AsyncGenerator<number, void, undefined> {
  for (;;) {
    const frame = await connection.next();

    if (frame === null) {
      return;
    }

    if (frame.type === FRAME_TYPES.connection) {
      yield decodeMessageFrame(ConnectionSchema, frame).id;
    }
  }
}
