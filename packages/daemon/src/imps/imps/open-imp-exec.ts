import type { SessionInfo } from '@impz/agent-protocol';
import { readImpById } from '../../platform/db/imps';
import type { ImpRecord } from '../../platform/db/imps';
import type { AgentFeature } from '../../vm/agent-client/agent-outdated';
import { sendActivity } from '../../vm/agent-client/agent-requests';
import { openExecStream } from '../../vm/agent-client/exec-stream';
import type { AgentExecRequest, ExecStream } from '../../vm/agent-client/exec-stream';
import type { ImpPaths } from '../../vm/storage/data-layout';
import { checkBrokerAttach, checkOpenedSession } from '../exec/broker-sessions';
import { buildBrokerNotReadyError, checkBrokerReady, isBrokerRequired } from '../exec/exec-require';
import { mergeEnv } from '../exec/merge-env';
import { findSessionLogImp } from '../session-logs/find-session-log-imp';
import type { ImpClock, ImpGuest, ImpHost, ImpMemory, ImpVms } from './imp-context';
import type { ImpLock } from './imp-lock';
import type { ImpVmOps } from './imp-vm-ops';
import { requireFeature } from './require-feature';
import { withColdBoots } from './with-cold-boots';

interface ExecParts {
  readonly context: ImpHost & ImpClock & ImpVms & ImpMemory & ImpGuest;
  readonly lock: ImpLock;
  readonly ops: ImpVmOps;
}

export function openImpExec(
  parts: ExecParts,
  name: string,
  request: AgentExecRequest,
  feature: AgentFeature | undefined,
  paths: ImpPaths,
  imp: ImpRecord,
): Promise<ExecStream> {
  const context = parts.context;
  const lock = parts.lock;
  const ops = parts.ops;
  const requiresBroker = isBrokerRequired(request.require);

  if (requiresBroker && request.outer === true) {
    throw buildBrokerNotReadyError('an exec in the agent gets no broker variables');
  }

  if (request.session !== undefined) {
    requireFeature(paths, 'sessions');
  }

  if (feature !== undefined) {
    requireFeature(paths, feature);
  }

  if (request.dropSysAdmin === true) {
    requireFeature(paths, 'drop-sys-admin');
  }

  if (request.outer === true) {
    requireFeature(paths, 'outer-exec');

    return openExecStream(paths.vsockSocket, request);
  }

  const startWithBroker = async (target: ImpRecord): Promise<ExecStream> => {
    const broker = await context.readExecEnv(target, paths.vsockSocket);

    const base = broker.kind === 'ready' ? broker.env : [];
    const env = mergeEnv(base, request.env ?? []);

    if (requiresBroker) {
      const refused = checkBrokerReady(broker, env);

      if (refused !== null) {
        throw refused;
      }

      await requireSameBoot(context, target);
    }

    const session = request.session;
    const listed: SessionInfo[] = [];

    if (requiresBroker && session !== undefined) {
      const activity = await sendActivity(paths.vsockSocket);

      listed.push(...activity.sessions);

      const refused = await checkBrokerAttach(
        context.db,
        target.id,
        session,
        request.resumeFrom?.executionGeneration,
        listed,
      );

      if (refused !== null) {
        throw refused;
      }
    }

    const opening = openExecStream(paths.vsockSocket, {
      ...request,
      ...(env.length > 0 && { env }),
    });

    if (session === undefined) {
      return opening;
    }

    const openNoted = async (): Promise<ExecStream> => {
      const stream = await opening;

      if (!requiresBroker) {
        return stream;
      }

      const refused = await checkOpenedSession(context.db, target.id, session, stream, listed);

      if (refused !== null) {
        stream.close();
        throw refused;
      }

      return stream;
    };

    return withColdBoots(context, target, openNoted()).then((stream) => {
      startNewLogTap(context, target, stream);

      return stream;
    });
  };

  if (!requiresBroker) {
    return startWithBroker(imp);
  }

  return lock.withImp(name, async (locked) => {
    const running = locked.state === 'running' ? locked : await ops.requireRunningImp(locked);

    return startWithBroker(running);
  });
}

async function requireSameBoot(context: ImpHost, imp: ImpRecord): Promise<void> {
  const fresh = await readImpById(context.db, imp.id);

  if (fresh?.state !== 'running' || fresh.pid !== imp.pid) {
    throw buildBrokerNotReadyError('the imp booted again after the broker CA step');
  }
}

// A new logged session is tapped at once, while the agent's ring buffer still
// holds its first output.
function startNewLogTap(
  context: ImpVms & ImpGuest,
  imp: Readonly<ImpRecord>,
  stream: Readonly<ExecStream>,
) {
  const output = stream.output;

  if (
    stream.created &&
    stream.session !== null &&
    output?.continuity === 'offsets' &&
    output.log?.enabled === true
  ) {
    context.sessionLogs.tapNow(findSessionLogImp(context.findPaths, imp), {
      name: stream.session,
      executionGeneration: output.executionGeneration,
      bootId: output.bootId,
    });
  }
}
