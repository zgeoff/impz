import type { Session, SessionLog, SessionLogRead } from '@impz/api';
import { updateImpActivity } from '../../../platform/db/imps';
import type { ImpRecord } from '../../../platform/db/imps';
import {
  buildAgentOutdatedApiError,
  buildNotFoundError,
} from '../../../platform/errors/impd-errors';
import { sendActivity, sendSessionKill } from '../../../vm/agent-client/agent-requests';
import { isAgentError } from '../../../vm/agent-client/is-agent-error';
import { toSeenSessions } from '../../../vm/agent-client/seen-session';
import type { ImpGuest, ImpHost, ImpVms } from '../imp-context';
import type { ImpLock } from '../imp-lock';
import type { ImpRuntime } from '../imp-runtime';
import { findSessionLogImp } from '../session-logs/find-session-log-imp';
import type { SessionLogReadRequest } from '../session-logs/session-log-files';
import type { SessionLogTarget } from '../session-logs/session-log-service';
import { readSeenSessions } from './count-sessions';
import { toApiSession } from './to-api-session';

export interface SessionService {
  readonly listSessions: (name: string) => Promise<Session[]>;
  readonly killSession: (name: string, session: string) => Promise<void>;
  readonly listSessionLogs: (name: string, session?: string) => Promise<SessionLog[]>;
  readonly readSessionLog: (
    name: string,
    request: Readonly<SessionLogReadRequest>,
  ) => Promise<SessionLogRead>;
  readonly removeSessionLogs: (name: string, target: Readonly<SessionLogTarget>) => Promise<number>;
}

interface SessionServiceParts {
  readonly context: ImpHost & ImpVms & ImpGuest;
  readonly lock: Pick<ImpLock, 'findImp'>;
  readonly requireRunning: ImpRuntime['requireRunning'];
}

export function createSessionService(parts: SessionServiceParts): SessionService {
  const context = parts.context;

  const readSessions = async (imp: ImpRecord) => {
    if (imp.state === 'running') {
      try {
        const activity = await sendActivity(context.findPaths(imp.id).vsockSocket);

        const seen = toSeenSessions(activity.sessions, new Date());

        context.sessions.record(imp.id, seen);
        context.sessionLogs.observe(findSessionLogImp(context.findPaths, imp), activity.sessions);

        return seen;
      } catch {
        // A busy or wedged agent falls back to the sessions impd saw last.
      }
    }

    return readSeenSessions(context, imp) ?? [];
  };

  const readLogImp = async (name: string) => {
    const imp = await parts.lock.findImp(name);

    return findSessionLogImp(context.findPaths, imp);
  };

  return {
    listSessionLogs: async (name, session) => {
      const imp = await readLogImp(name);

      return context.sessionLogs.listLogs(imp, session);
    },
    readSessionLog: async (name, request) => {
      const imp = await readLogImp(name);

      return context.sessionLogs.readLog(imp, request);
    },
    removeSessionLogs: async (name, target) => {
      const imp = await readLogImp(name);

      return context.sessionLogs.removeLogs(imp, target);
    },

    listSessions: async (name) => {
      const imp = await parts.lock.findImp(name);
      const sessions = await readSessions(imp);

      return sessions.map((session) => toApiSession(session));
    },

    killSession: async (name, session) => {
      const opened = { release: () => {} };

      try {
        const running = await parts.requireRunning(name, (found) => {
          opened.release = context.tracker.open(found.id, 'exec');
        });

        const imp = running.imp;

        await updateImpActivity(context.db, imp.id, new Date());

        await sendSessionKill(context.findPaths(imp.id).vsockSocket, session).catch(
          (error: unknown) => {
            if (isAgentError(error, 'NO_SESSION')) {
              throw buildNotFoundError('session', session);
            }

            if (isAgentError(error, 'AGENT_OUTDATED')) {
              throw buildAgentOutdatedApiError(error.message);
            }

            throw error;
          },
        );

        const seen = context.sessions.read(imp.id);

        if (seen !== undefined) {
          context.sessions.record(
            imp.id,
            seen.filter((entry) => entry.name !== session),
          );
        }
      } finally {
        opened.release();
      }
    },
  };
}
