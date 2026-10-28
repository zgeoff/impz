import { isAgentLogIdentity } from '../../../vm/agent-client/agent-ids';
import { buildLogKey } from './build-log-key';
import type { SessionLogState } from './create-session-log-state';
import type { GenerationLog, createGenerationLog } from './generation-log';
import { probeTombstone, removeEmptyDirs, removeGenerationDir } from './session-log-files';
import type { LiveLog } from './session-log-machine';
import type { SessionLogImp, SessionLogLimits } from './session-log-service';

interface CreateLiveLogDeps {
  readonly limits: SessionLogLimits;
  readonly now: () => number;
  readonly createLog: typeof createGenerationLog;
}

interface CreateLiveLogOptions {
  readonly imp: SessionLogImp;
  readonly generation: string;
  readonly session: string;
  readonly bootId: string;
  readonly life: number;
}

export function makeCreateLiveLog(
  ctx: SessionLogState,
  deps: CreateLiveLogDeps,
): (options: CreateLiveLogOptions) => Promise<LiveLog | null> {
  const createLiveLog = async (options: CreateLiveLogOptions): Promise<LiveLog | null> => {
    const imp = options.imp;
    const generation = options.generation;
    const session = options.session;
    const bootId = options.bootId;
    const key = buildLogKey(imp.id, generation);

    if (!isAgentLogIdentity({ generation, session, bootId })) {
      return null;
    }

    if (ctx.isForgotten(imp.id, options.life) || probeTombstone(imp.sessionLogsDir, generation)) {
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

    if (ctx.isForgotten(imp.id, options.life)) {
      log.abandon();

      if (ctx.isDestroyed(imp.id)) {
        removeGenerationDir(imp.sessionLogsDir, generation);
        removeEmptyDirs(imp.sessionLogsDir);
      }

      return null;
    }

    return ctx.setLive({ imp, generation, session, log });
  };

  return createLiveLog;
}
