import type { Session } from '@impz/api';
import { isAgentSessionState } from '../../vm/agent-client/is-agent-session-state';
import { getSignalName } from '../exec/signal-names';
import type { SeenSession } from './session-cache';

export function toApiSession(session: SeenSession): Session {
  const hasOffsets = session.executionGeneration !== '';

  const api: Session = {
    name: session.name,
    pid: session.pid,
    argv: [...session.argv],
    state: getSessionState(session.state),
    attached: session.attached,
    cols: session.cols,
    rows: session.rows,
    startedAt: new Date(session.startedUnixMs),

    continuity: hasOffsets ? 'offsets' : 'none',
    ...(hasOffsets && {
      executionGeneration: session.executionGeneration,
      bootId: session.bootId,
      end: session.end,
    }),
    ...(hasOffsets &&
      session.observedUnixMs !== undefined && {
        endObservedAt: new Date(session.observedUnixMs),
      }),
    ...(session.log === true && { log: true }),
  };

  if (session.exit !== undefined) {
    const signalled = session.exit.signal !== 0;

    api.exit = {
      code: signalled ? null : session.exit.code,
      signal: signalled ? getSignalName(session.exit.signal) : null,
    };
  }

  return api;
}

function getSessionState(state: string): Session['state'] {
  if (!isAgentSessionState(state)) {
    throw new Error(`a session in state ${JSON.stringify(state)}`);
  }

  return state;
}
