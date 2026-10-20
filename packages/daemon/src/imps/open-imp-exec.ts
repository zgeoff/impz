import type { AgentFeature } from '../agent-client/agent-outdated';
import type { SessionInfo } from '../agent-client/agent-protocol';
import { sendActivity } from '../agent-client/agent-requests';
import { openExecStream } from '../agent-client/exec-stream';
import type { AgentExecRequest, ExecStream } from '../agent-client/exec-stream';
import { readImpById } from '../db/imps';
import type { ImpRecord } from '../db/imps';
import { checkBrokerAttach, checkOpenedSession } from '../exec/broker-sessions';
import { buildBrokerNotReadyError, checkBrokerReady, isBrokerRequired } from '../exec/exec-require';
import { mergeEnv } from '../exec/merge-env';
import { findSessionLogImp } from '../session-logs/find-session-log-imp';
import type { ImpPaths } from '../storage/data-layout';
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

// an exec in the running imp at `paths`: the broker's variables, and the
// checks of a command that requires the broker
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

  // the egress broker's variables are for the imp's own code, not the
  // agent's world
  if (requiresBroker && request.outer === true) {
    throw buildBrokerNotReadyError('an exec in the agent gets no broker variables');
  }

  // an old agent would run a session's command as a plain exec
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

  // the broker's variables under the caller's own; a command that
  // requires the broker starts only with them as impd set them
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

    // the agent's sessions, for a start that requires the broker and
    // may attach: a refused attach must not reach the agent
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

    // a session this start created gets its log tap once it opens
    return withColdBoots(context, target, openNoted()).then((stream) => {
      startNewLogTap(context, target, stream);

      return stream;
    });
  };

  if (!requiresBroker) {
    return startWithBroker(imp);
  }

  // Under the lock no restore, reboot or sleep replaces the guest
  // between the bundle step and the start; an imp a stop got to first
  // boots again, as for any exec. It may wait behind a locked operation.
  return lock.withImp(name, async (locked) => {
    const running = locked.state === 'running' ? locked : await ops.requireRunningImp(locked);

    return startWithBroker(running);
  });
}

// The guest the bundle step ran in is the one the command starts in: the
// caller holds the lock, and this catches any write that got past it.
async function requireSameBoot(context: ImpHost, imp: ImpRecord): Promise<void> {
  const fresh = await readImpById(context.db, imp.id);

  if (fresh?.state !== 'running' || fresh.pid !== imp.pid) {
    throw buildBrokerNotReadyError('the imp booted again after the broker CA step');
  }
}

// a session that just started with log is tapped at once, while the agent's
// ring still holds its first output
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
