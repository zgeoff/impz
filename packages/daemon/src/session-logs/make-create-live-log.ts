import { isAgentLogIdentity } from '../agent-client/agent-ids';
import { buildLogKey } from './build-log-key';
import type { SessionLogState } from './create-session-log-state';
import type { GenerationLog, createGenerationLog } from './generation-log';
import { hasTombstone, removeEmptyDirs, removeGenerationDir } from './session-log-files';
import type { LiveLog } from './session-log-machine';
import type { SessionLogImp, SessionLogLimits } from './session-log-service';

// what a new live log reads besides the state
interface CreateLiveLogDeps {
  readonly limits: SessionLogLimits;
  readonly now: () => number;
  readonly createLog: typeof createGenerationLog;
}

export function makeCreateLiveLog(
  ctx: SessionLogState,
  deps: CreateLiveLogDeps,
): (
  imp: SessionLogImp,
  generation: string,
  session: string,
  bootId: string,
  life: number,
) => Promise<LiveLog | null> {
  // a log for a generation impd has not logged: null when the imp has its
  // cap of live logs, the generation was deleted, or the imp is destroyed
  const createLiveLog = async (
    imp: SessionLogImp,
    generation: string,
    session: string,
    bootId: string,
    life: number,
  ): Promise<LiveLog | null> => {
    const key = buildLogKey(imp.id, generation);

    if (!isAgentLogIdentity({ generation, session, bootId })) {
      return null;
    }

    if (ctx.isForgotten(imp.id, life) || hasTombstone(imp.sessionLogsDir, generation)) {
      return null;
    }

    if (ctx.listLive(imp.id).length + ctx.countCreating(imp.id) >= deps.limits.impMaxLive) {
      ctx.send({ type: 'cap.refuse', impId: imp.id, at: deps.now() });

      return null;
    }

    ctx.send({ type: 'creation.start', key });

    let log: GenerationLog;

    try {
      log = await deps.createLog(ctx.buildOptions(imp, generation), {
        session,
        executionGeneration: generation,
        bootId,
      });
    } finally {
      ctx.send({ type: 'creation.end', key });
    }

    // destroyed while the directory was made: it goes again, unless the imp
    // is back under its id, whose log of the generation it may be now
    if (ctx.isForgotten(imp.id, life)) {
      log.abandon();

      if (ctx.isDestroyed(imp.id)) {
        removeGenerationDir(imp.sessionLogsDir, generation);
        removeEmptyDirs(imp.sessionLogsDir);
      }

      return null;
    }

    return ctx.setLive(imp, generation, session, log);
  };

  return createLiveLog;
}
