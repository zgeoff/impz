import { isAgentLogIdentity } from '../agent-client/agent-ids';
import { buildLogKey } from './build-log-key';
import type { LiveLog, SessionLogState } from './create-session-log-state';
import type { GenerationLog, createGenerationLog } from './generation-log';
import { hasTombstone, removeEmptyDirs, removeGenerationDir } from './session-log-files';
import type { SessionLogImp, SessionLogLimits } from './session-log-service';

// what a new live log reads besides the state
interface CreateLiveLogDeps {
  readonly limits: SessionLogLimits;
  readonly now: () => number;
  readonly log: (message: string) => void;
  readonly createLog: typeof createGenerationLog;
}

// how often an imp at its cap of live logs says so
const CAP_NOTICE_MS = 60_000;

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
  const countCreating = (impId: string) =>
    [...ctx.creating].filter((key) => key.startsWith(`${impId}/`)).length;

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

    if (ctx.listLive(imp.id).length + countCreating(imp.id) >= deps.limits.impMaxLive) {
      const last = ctx.capNotices.get(imp.id) ?? 0;

      if (deps.now() - last >= CAP_NOTICE_MS) {
        ctx.capNotices.set(imp.id, deps.now());

        deps.log(
          `impd: imp ${imp.id}: logs no more sessions: it has ${String(deps.limits.impMaxLive)} live logs`,
        );
      }

      return null;
    }

    ctx.creating.add(key);

    let log: GenerationLog;

    try {
      log = await deps.createLog(ctx.buildOptions(imp, generation), {
        session,
        executionGeneration: generation,
        bootId,
      });
    } finally {
      ctx.creating.delete(key);
    }

    // destroyed while the directory was made: it goes again, unless the imp
    // is back under its id, whose log of the generation it may be now
    if (ctx.isForgotten(imp.id, life)) {
      log.abandon();

      if (ctx.forgotten.has(imp.id)) {
        removeGenerationDir(imp.sessionLogsDir, generation);
        removeEmptyDirs(imp.sessionLogsDir);
      }

      return null;
    }

    return ctx.setLive(imp, generation, session, log);
  };

  return createLiveLog;
}
