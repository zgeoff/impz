import type { PreviousGeneration, ResumeFrom, SessionLog, SessionLogRead } from '@impz/api';
import { PreviousGenerationSchema } from '@impz/api';
import * as z from 'zod';
import { isAgentLogIdentity } from '../agent-client/agent-ids';
import type { SessionInfo } from '../agent-client/agent-protocol';
import { openTapStream } from '../agent-client/exec-stream';
import type { ExecStream } from '../agent-client/exec-stream';
import { isAgentError } from '../agent-client/is-agent-error';
import { buildLogKey } from './build-log-key';
import { createSessionLogState } from './create-session-log-state';
import {
  createGenerationLog,
  loadGenerationLog,
  readGenerationBounds,
  readGenerationMeta,
} from './generation-log';
import type { GenerationEnd, GenerationLogOptions } from './generation-log';
import { makeApplyImpLimit } from './make-apply-imp-limit';
import { makeCreateLiveLog } from './make-create-live-log';
import { makeRunTap } from './make-run-tap';
import {
  findGenerationDir,
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

// Session logs (docs/architecture/guest/sessions.md#session-logs). impd taps each
// session the agent marks `log`, beside its viewer, and writes its output
// under the imp's directory. Each look at the sessions taps what is untapped.

export interface SessionLogLimits {
  // one generation's log, of which it keeps at least half the newest
  readonly generationMaxBytes: number;

  // an imp's logs together; ended generations go first, oldest first, then
  // the live logs' oldest segments, then the newest live log stops
  readonly impMaxBytes: number;

  // live logs per imp: a forged agent can list any number of generations
  readonly impMaxLive: number;

  // an ended generation's log goes this long after it ended
  readonly maxAgeMs: number;
}

export interface SessionLogImp {
  readonly id: string;
  readonly state: string;
  readonly vsockPath: string;
  readonly sessionLogsDir: string;
}

type TappedSession = Pick<SessionInfo, 'name' | 'executionGeneration' | 'bootId'>;

// what a delete names: without a generation every one of the session, and
// without a session every log of the imp
export interface SessionLogTarget {
  readonly session?: string | undefined;
  readonly executionGeneration?: string | undefined;
}

export interface SessionLogs {
  // a running imp's sessions as impd just listed them: taps each logged one
  // that is untapped, and ends the logs of generations that are gone
  readonly observe: (imp: SessionLogImp, sessions: readonly SessionInfo[]) => void;

  // a session just started with log: tapped now, not at the next look
  readonly tapNow: (imp: SessionLogImp, session: Readonly<TappedSession>) => void;

  // the imp's VM is gone (a stop, an error): each of its live logs ends
  readonly endImp: (imp: SessionLogImp) => Promise<void>;

  // the imp is being destroyed: taps close and nothing more is written
  readonly forgetImp: (impId: string) => void;

  // an imp was made under the id, a move home included: it logs again
  readonly admitImp: (impId: string) => void;

  readonly listLogs: (imp: SessionLogImp, session?: string) => SessionLog[];
  readonly readLog: (imp: SessionLogImp, request: SessionLogReadRequest) => Promise<SessionLogRead>;
  readonly deleteLogs: (imp: SessionLogImp, target: SessionLogTarget) => number;

  // ends the live logs of imps whose VM is gone and removes ended logs past
  // their age; `imps` is every imp the database has
  readonly sweep: (imps: readonly SessionLogImp[]) => Promise<void>;
}

interface SessionLogDeps {
  readonly limits: SessionLogLimits;
  readonly requireRoom: (bytes: number) => Promise<void>;
  readonly now: () => number;
  readonly log: (message: string) => void;

  // starts each log's commit timer; setTimeout by default, a test fires it
  readonly startTimer?: GenerationLogOptions['startTimer'];

  // called once per look (observe, tapNow) as every tap it tried has reached
  // its pump or been refused; the look itself runs on until its pumps end
  // and changes nothing for it. A test waits on it.
  readonly onLookDone?: () => void;
  readonly openTap?: (
    vsockPath: string,
    session: string,
    resumeFrom?: ResumeFrom,
  ) => Promise<ExecStream>;

  // makes a new generation's log; a test holds it, or the log's writes
  readonly createLog?: typeof createGenerationLog;
}

// NO_SESSION's data in the API's shape: the generation that last left the
// name, with its final end and exit code
const NoSessionPreviousSchema = z.object({ previous: PreviousGenerationSchema.optional() });

// the final end of the generation `previous` names, if it is this one
function toPreviousEnd(
  previous: PreviousGeneration | undefined,
  generation: string,
): GenerationEnd {
  if (previous?.executionGeneration !== generation) {
    return {};
  }

  return { end: previous.end, exitCode: previous.exitCode };
}

export function createSessionLogs(deps: SessionLogDeps): SessionLogs {
  const openTap = deps.openTap ?? openTapStream;
  const createLog = deps.createLog ?? createGenerationLog;
  const ctx = createSessionLogState(deps);

  // the live logs an earlier impd left come back, so the rules that end or
  // tap live logs cover them too
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

  // generation_changed: the named generation is gone, and the tap carries
  // the one that runs now under the name, from its first offset
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

    // a forged next generation ends nothing and makes nothing
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
    const dir = findGenerationDir(imp.sessionLogsDir, output.executionGeneration);

    if (ctx.isTapped(key) || ctx.isDropped(key) || readGenerationMeta(dir) !== null) {
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
      // nobody reads the tap now: the next look taps the generation again
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

  // NO_SESSION or BAD_REQUEST (no longer logged): the generation ended
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
    const logEnd = readGenerationBounds(meta).logEnd;

    const resumeFrom =
      meta.segments.length === 0 && logEnd === 0
        ? undefined
        : { executionGeneration: entry.generation, offset: logEnd };

    let tap: ExecStream;

    try {
      tap = await openTap(imp.vsockPath, entry.session, resumeFrom);
    } catch (error) {
      // destroyed meanwhile: the slot under the key may be the imp's next life's
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

    // the log went while the tap opened: a delete, a destroy
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

    // an agent from before output offsets names no generation
    if (generation === '') {
      return;
    }

    if (!isAgentLogIdentity({ generation, session: session.name, bootId })) {
      return;
    }

    const key = buildLogKey(imp.id, generation);
    const opening: OpeningTap = { opening: true };

    ctx.send({ type: 'tap.open', key, slot: opening });

    // dropped, or tapped already
    if (ctx.findTap(key) !== opening) {
      return;
    }

    try {
      let entry = ctx.findLive(key);

      if (entry === undefined) {
        // an ended log is not written again
        if (readGenerationMeta(findGenerationDir(imp.sessionLogsDir, generation)) !== null) {
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

  // taps the session until its tap ends; `emitReached` runs once, as its
  // pump starts or as soon as no pump will
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

  // runs the look; its `emitLookDone` reports it to onLookDone once, early
  // when the look says so, else when it ends
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

    // the VM is gone, and every generation it ran with it; a later life's
    // tombstones are its own
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

        // a deleted generation that is gone can never be tapped again
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

        // the look is done for onLookDone once every tap reached its pump or
        // was refused; it still ends only as its pumps end
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
        .toSorted((a, b) => b.startedAt - a.startedAt)
        .map((meta) => toApiSessionLog(meta)),

    readLog: (imp, request) =>
      readSessionLogRange(imp.sessionLogsDir, ctx.readLive(imp.id), request),

    deleteLogs: (imp, target) => {
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

          // a restarted impd must not tap it again
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
