import type { PreviousGeneration, ResumeFrom, SessionLog, SessionLogRead } from '@impz/api';
import { PreviousGenerationSchema } from '@impz/api';
import * as z from 'zod';
import { isAgentLogIdentity } from '../../vm/agent-client/agent-ids';
import type { SessionInfo } from '../../vm/agent-client/agent-protocol';
import { openTapStream } from '../../vm/agent-client/exec-stream';
import type { ExecStream } from '../../vm/agent-client/exec-stream';
import { isAgentError } from '../../vm/agent-client/is-agent-error';
import { buildLogKey } from './build-log-key';
import { createSessionLogState } from './create-session-log-state';
import {
  createGenerationLog,
  getGenerationBounds,
  loadGenerationLog,
  readGenerationMeta,
} from './generation-log';
import type { GenerationEnd, GenerationLogOptions } from './generation-log';
import { makeApplyImpLimit } from './make-apply-imp-limit';
import { makeCreateLiveLog } from './make-create-live-log';
import { makeRunTap } from './make-run-tap';
import {
  getGenerationDir,
  listTombstones,
  readImpMetas,
  readSessionLogRange,
  removeGenerationDir,
  removeTombstone,
  toApiSessionLog,
  writeTombstone,
} from './session-log-files';
import type { SessionLogReadRequest } from './session-log-files';
import type { LiveLog, OpeningTap } from './session-log-machine';

export interface SessionLogLimits {
  readonly generationMaxBytes: number;

  readonly impMaxBytes: number;

  readonly impMaxLive: number;

  readonly maxAgeMs: number;
}

export interface SessionLogImp {
  readonly id: string;
  readonly state: string;
  readonly vsockPath: string;
  readonly sessionLogsDir: string;
}

type TappedSession = Pick<SessionInfo, 'name' | 'executionGeneration' | 'bootId'>;

export interface SessionLogTarget {
  readonly session?: string | undefined;
  readonly executionGeneration?: string | undefined;
}

export interface SessionLogs {
  readonly observe: (imp: SessionLogImp, sessions: readonly SessionInfo[]) => void;

  readonly tapNow: (imp: SessionLogImp, session: Readonly<TappedSession>) => void;

  readonly endImp: (imp: SessionLogImp) => Promise<void>;

  readonly forgetImp: (impId: string) => void;

  readonly admitImp: (impId: string) => void;

  readonly listLogs: (imp: SessionLogImp, session?: string) => SessionLog[];
  readonly readLog: (imp: SessionLogImp, request: SessionLogReadRequest) => Promise<SessionLogRead>;
  readonly removeLogs: (imp: SessionLogImp, target: SessionLogTarget) => number;

  readonly sweep: (imps: readonly SessionLogImp[]) => Promise<void>;
}

interface SessionLogDeps {
  readonly limits: SessionLogLimits;
  readonly requireRoom: (bytes: number) => Promise<void>;
  readonly now: () => number;
  readonly log: (message: string) => void;

  readonly startTimer?: GenerationLogOptions['startTimer'];

  readonly onLookDone?: () => void;
  readonly openTap?: (
    vsockPath: string,
    session: string,
    resumeFrom?: ResumeFrom,
  ) => Promise<ExecStream>;

  readonly createLog?: typeof createGenerationLog;
}

const NoSessionPreviousSchema = z.object({ previous: PreviousGenerationSchema.optional() });

export function createSessionLogs(deps: SessionLogDeps): SessionLogs {
  const openTap = deps.openTap ?? openTapStream;
  const createLog = deps.createLog ?? createGenerationLog;
  const ctx = createSessionLogState(deps);

  const loadImpLogs = async (imp: SessionLogImp, life: number): Promise<void> => {
    if (ctx.isRecovered(imp.id) || ctx.isForgotten(imp.id, life)) {
      return;
    }

    ctx.send({ type: 'imp.recover', impId: imp.id });

    for (const meta of readImpMetas(imp.sessionLogsDir, ctx.readLive(imp.id))) {
      const key = buildLogKey(imp.id, meta.executionGeneration);

      if (meta.state === 'live' && ctx.findLive(key) === undefined) {
        const options = ctx.buildOptions(imp, meta.executionGeneration);

        const log = await loadGenerationLog(options, meta);

        if (ctx.isForgotten(imp.id, life)) {
          log.abandon();

          return;
        }

        ctx.setLive(imp, meta.executionGeneration, meta.session, log, meta.stopped !== undefined);
      }
    }
  };

  const applyImpLimit = makeApplyImpLimit(ctx, deps);
  const createLiveLog = makeCreateLiveLog(ctx, { limits: deps.limits, now: deps.now, createLog });
  const runTap = makeRunTap(ctx, { log: deps.log, applyImpLimit });

  const startNextGeneration = async (
    imp: SessionLogImp,
    entry: LiveLog,
    tap: Readonly<ExecStream>,
    life: number,
    emitReached: () => void,
  ): Promise<void> => {
    const output = tap.output;

    if (output?.continuity !== 'offsets') {
      tap.close();

      return;
    }

    const identity = {
      generation: output.executionGeneration,
      session: entry.session,
      bootId: output.bootId,
    };

    if (!isAgentLogIdentity(identity)) {
      tap.close();

      return;
    }

    await ctx.writeEnd(entry, toPreviousEnd(output.previous, entry.generation));

    if (ctx.isForgotten(imp.id, life)) {
      tap.close();

      return;
    }

    const key = buildLogKey(imp.id, output.executionGeneration);
    const directory = getGenerationDir(imp.sessionLogsDir, output.executionGeneration);

    if (ctx.isTapped(key) || ctx.isDropped(key) || readGenerationMeta(directory) !== null) {
      tap.close();

      return;
    }

    ctx.send({ type: 'tap.open', key, slot: tap });

    let next: LiveLog | null;

    try {
      next = await createLiveLog(
        imp,
        output.executionGeneration,
        entry.session,
        output.bootId,
        life,
      );
    } catch (error) {
      ctx.send({ type: 'tap.release', key, owner: tap });
      tap.close();
      throw error;
    }

    if (next === null || ctx.findTap(key) !== tap) {
      ctx.send({ type: 'tap.release', key, owner: tap });
      tap.close();

      return;
    }

    next.log.setOrigin(output.offset);

    emitReached();

    await runTap(imp, next, tap, life);
  };

  const writeGoneEnd = async (entry: LiveLog, errorData: unknown): Promise<void> => {
    const previous = NoSessionPreviousSchema.safeParse(errorData).data?.previous;

    await ctx.writeEnd(entry, toPreviousEnd(previous, entry.generation));
  };

  const openEntryTap = async (
    imp: SessionLogImp,
    entry: LiveLog,
    life: number,
    opening: OpeningTap,
    emitReached: () => void,
  ): Promise<void> => {
    const meta = entry.log.readMeta();
    const logEnd = getGenerationBounds(meta).logEnd;

    const resumeFrom =
      meta.segments.length === 0 && logEnd === 0
        ? undefined
        : { executionGeneration: entry.generation, offset: logEnd };

    let tap: ExecStream;

    try {
      tap = await openTap(imp.vsockPath, entry.session, resumeFrom);
    } catch (error) {
      if (ctx.isForgotten(imp.id, life)) {
        return;
      }

      ctx.send({ type: 'tap.release', key: entry.key, owner: opening });

      if (isAgentError(error, 'NO_SESSION', 'BAD_REQUEST')) {
        await writeGoneEnd(entry, error.data);

        return;
      }

      throw error;
    }

    if (ctx.isForgotten(imp.id, life)) {
      tap.close();

      return;
    }

    const output = tap.output?.continuity === 'offsets' ? tap.output : null;
    const resume = output?.resume;

    if (resume?.kind === 'generation_changed') {
      ctx.send({ type: 'tap.release', key: entry.key, owner: opening });

      await startNextGeneration(imp, entry, tap, life, emitReached);

      return;
    }

    if (resume?.kind === 'gap') {
      entry.log.skipTo(resume.to);
    } else if (resumeFrom === undefined && output !== null) {
      entry.log.setOrigin(output.offset);
    }

    ctx.send({ type: 'tap.attach', key: entry.key, opening, tap });

    if (ctx.findTap(entry.key) !== tap) {
      tap.close();

      return;
    }

    emitReached();

    await runTap(imp, entry, tap, life);
  };

  const openSessionTap = async (
    imp: SessionLogImp,
    session: Readonly<TappedSession>,
    life: number,
    emitReached: () => void,
  ): Promise<void> => {
    const generation = session.executionGeneration;
    const bootId = session.bootId;

    if (generation === '') {
      return;
    }

    if (!isAgentLogIdentity({ generation, session: session.name, bootId })) {
      return;
    }

    const key = buildLogKey(imp.id, generation);
    const opening: OpeningTap = { opening: true };

    ctx.send({ type: 'tap.open', key, slot: opening });

    if (ctx.findTap(key) !== opening) {
      return;
    }

    try {
      let entry = ctx.findLive(key);

      if (entry === undefined) {
        if (readGenerationMeta(getGenerationDir(imp.sessionLogsDir, generation)) !== null) {
          ctx.send({ type: 'tap.release', key, owner: opening });

          return;
        }

        const created = await createLiveLog(imp, generation, session.name, bootId, life);

        if (created === null) {
          ctx.send({ type: 'tap.release', key, owner: opening });

          return;
        }

        entry = created;
      }

      if (ctx.isForgotten(imp.id, life)) {
        ctx.send({ type: 'tap.release', key, owner: opening });

        return;
      }

      await openEntryTap(imp, entry, life, opening, emitReached);
    } catch (error) {
      ctx.send({ type: 'tap.release', key, owner: opening });
      throw error;
    }
  };

  const startTap = async (
    imp: SessionLogImp,
    session: Readonly<TappedSession>,
    life: number,
    emitReached: () => void,
  ): Promise<void> => {
    const reached = { isDone: false };

    const emitReachedOnce = (): void => {
      if (!reached.isDone) {
        reached.isDone = true;

        emitReached();
      }
    };

    try {
      await openSessionTap(imp, session, life, emitReachedOnce);
    } finally {
      emitReachedOnce();
    }
  };

  const runInBackground = (
    imp: SessionLogImp,
    task: (emitLookDone: () => void) => Promise<void>,
  ): void => {
    const looked = { isDone: false };

    const emitLookDone = (): void => {
      if (!looked.isDone) {
        looked.isDone = true;
        deps.onLookDone?.();
      }
    };

    void (async () => {
      try {
        await task(emitLookDone);
      } catch (error) {
        ctx.printError(imp, error);
      } finally {
        emitLookDone();
      }
    })();
  };

  const stopImpLogs = async (imp: SessionLogImp): Promise<void> => {
    const life = ctx.readLife(imp.id);

    await loadImpLogs(imp, life);

    for (const entry of ctx.listLive(imp.id)) {
      await ctx.writeEnd(entry, {});
    }

    if (ctx.isForgotten(imp.id, life)) {
      return;
    }

    for (const generation of listTombstones(imp.sessionLogsDir)) {
      removeTombstone(imp.sessionLogsDir, generation);
    }
  };

  const removeExpired = (imp: SessionLogImp, cutoff: number): void => {
    for (const meta of readImpMetas(imp.sessionLogsDir, ctx.readLive(imp.id))) {
      if (meta.state === 'ended' && (meta.endedAt ?? 0) < cutoff) {
        removeGenerationDir(imp.sessionLogsDir, meta.executionGeneration);
      }
    }
  };

  return {
    observe: (imp, sessions) => {
      const life = ctx.readLife(imp.id);

      if (imp.state !== 'running' || ctx.isForgotten(imp.id, life)) {
        return;
      }

      runInBackground(imp, async (emitLookDone) => {
        await loadImpLogs(imp, life);

        if (ctx.isForgotten(imp.id, life)) {
          return;
        }

        const listed = new Set(sessions.map((session) => session.executionGeneration));

        for (const generation of listTombstones(imp.sessionLogsDir)) {
          if (!listed.has(generation)) {
            removeTombstone(imp.sessionLogsDir, generation);
          }
        }

        for (const entry of ctx.listLive(imp.id)) {
          if (!listed.has(entry.generation) && !ctx.isTapped(entry.key)) {
            await ctx.writeEnd(entry, {});
          }
        }

        const logged = sessions.filter((session) => session.log === true);
        const unreached = { count: logged.length };

        const emitReached = (): void => {
          unreached.count -= 1;

          if (unreached.count === 0) {
            emitLookDone();
          }
        };

        await Promise.all(logged.map((session) => startTap(imp, session, life, emitReached)));
      });
    },

    tapNow: (imp, session) => {
      const life = ctx.readLife(imp.id);

      runInBackground(imp, async (emitLookDone) => {
        await loadImpLogs(imp, life);
        await startTap(imp, session, life, emitLookDone);
      });
    },

    endImp: stopImpLogs,

    forgetImp: (impId) => {
      ctx.send({ type: 'imp.forget', impId });
    },

    admitImp: (impId) => {
      ctx.send({ type: 'imp.admit', impId });
    },

    listLogs: (imp, session) =>
      readImpMetas(imp.sessionLogsDir, ctx.readLive(imp.id))
        .filter((meta) => session === undefined || meta.session === session)
        .toSorted((left, right) => right.startedAt - left.startedAt)
        .map((meta) => toApiSessionLog(meta)),

    readLog: (imp, request) =>
      readSessionLogRange(imp.sessionLogsDir, ctx.readLive(imp.id), request),

    removeLogs: (imp, target) => {
      const doomed = readImpMetas(imp.sessionLogsDir, ctx.readLive(imp.id)).filter(
        (meta) =>
          (target.session === undefined || meta.session === target.session) &&
          (target.executionGeneration === undefined ||
            meta.executionGeneration === target.executionGeneration),
      );

      for (const meta of doomed) {
        const key = buildLogKey(imp.id, meta.executionGeneration);

        if (ctx.findLive(key) !== undefined) {
          ctx.send({ type: 'log.remove', key });

          writeTombstone(imp.sessionLogsDir, meta.executionGeneration);
        }

        removeGenerationDir(imp.sessionLogsDir, meta.executionGeneration);
      }

      return doomed.length;
    },

    sweep: async (imps) => {
      const cutoff = deps.now() - deps.limits.maxAgeMs;

      for (const imp of imps) {
        try {
          if (imp.state !== 'running' && imp.state !== 'sleeping') {
            await stopImpLogs(imp);
          }

          removeExpired(imp, cutoff);
        } catch (error) {
          ctx.printError(imp, error);
        }
      }
    },
  };
}

function toPreviousEnd(
  previous: PreviousGeneration | undefined,
  generation: string,
): GenerationEnd {
  if (previous?.executionGeneration !== generation) {
    return {};
  }

  return { end: previous.end, exitCode: previous.exitCode };
}
