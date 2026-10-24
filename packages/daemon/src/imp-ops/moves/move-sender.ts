import type { MovePlan, MoveStatus, WarmHost } from '@impz/api';
import type { LockedImp } from '../../imps/imps/imp-lock';
import type { Imps } from '../../imps/imps/imp-service';
import type { EgressService } from '../../network/egress/egress-service';
import { listCheckpoints } from '../../platform/db/checkpoints';
import { listImps, readImpById, readImpByName, updateImpMove } from '../../platform/db/imps';
import type { ImpRecord } from '../../platform/db/imps';
import {
  readMoveSend,
  removeMoveSend,
  updateMoveSend,
  writeMoveSend,
} from '../../platform/db/move-sends';
import type { ImpDatabase } from '../../platform/db/open-database';
import { ImpdError, isImpdError } from '../../platform/errors/impd-error';
import { buildInvalidStateError, buildNotFoundError } from '../../platform/errors/impd-errors';
import type { StartTimer } from '../../platform/process/clock';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import type { MoveMode, StorageBackend } from '../../vm/storage/storage-backend';
import type { ImpGrants } from '../imp-grants';
import type { ImpOpsConfig } from '../imp-ops-config';
import { checkWarmMove, requireSnapshotMeta } from './check-warm-move';
import { countMoveBytes } from './count-move-bytes';
import { MOVE_PATHS, MoveCommitReplySchema } from './move-header';
import { OfferRefusalError } from './offer-refusal-error';
import { parsePeerUrlAddress } from './peer-address';
import type { PeerRanges } from './peer-address';
import { requireOk } from './require-ok';
import { runMoveSend } from './run-move-send';
import type { SendTarget } from './run-move-send';
import { sendMoveAbort } from './send-move-abort';
import { sendToPeer } from './send-to-peer';

interface PrepareOptions {
  readonly stop: boolean;
  readonly force: boolean;
  readonly targetStorage: 'xfs' | 'zfs';
  readonly target: WarmHost | null;
}

export interface MoveSender {
  readonly prepare: (name: string, options: PrepareOptions) => Promise<MovePlan>;
  readonly send: (name: string, to: string, ticket: string) => Promise<MoveStatus>;
  readonly readStatus: (name: string) => Promise<MoveStatus>;
  readonly resume: (name: string, ticket: string | undefined) => Promise<MoveStatus>;
  readonly abort: (name: string) => Promise<MoveStatus>;
  readonly recover: () => Promise<void>;
  readonly waitForRecovery: () => Promise<void>;
}

export interface MoveSenderDeps {
  readonly config: Pick<ImpOpsConfig, 'subnet'>;
  readonly db: ImpDatabase;
  readonly dataDir: string;
  readonly storage: Pick<StorageBackend, 'kind' | 'openMoveSource' | 'resolveImpPaths'>;
  readonly imps: Pick<
    Imps,
    | 'lockImp'
    | 'haltImp'
    | 'destroyImp'
    | 'startImp'
    | 'requireRunningImp'
    | 'requireUnleased'
    | 'endForcedLeases'
  >;
  readonly grants: Pick<ImpGrants, 'listGrantDetails'>;
  readonly egress: Pick<EgressService, 'readPolicy' | 'readAnswers'>;
  readonly ranges: PeerRanges;
  readonly readWarmHost: () => WarmHost;
  readonly readTapMac?: (tap: string) => string | null;
  readonly releaseName: () => Promise<void>;
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly startPeerDeadline?: StartTimer;
  readonly partBytes?: number;
  readonly now: () => number;
}

interface SendTask {
  readonly abort: AbortController;
  done: Promise<void>;
  sentBytes: number;
  totalBytes: number;
  error: string | null;
  isDone: boolean;
}

export function createMoveSender(deps: MoveSenderDeps): MoveSender {
  const tasks = new Map<string, SendTask>();
  const finished = new Map<string, { readonly error: string | null; readonly isDone: boolean }>();
  const halted = new Set<string>();

  const requireImp = async (name: string): Promise<ImpRecord> => {
    const imp = await readImpByName(deps.db, name);

    if (imp === undefined) {
      throw buildNotFoundError('imp', name);
    }

    return imp;
  };

  const runCommit = async (imp: ImpRecord, peer: string, ticket: string): Promise<void> => {
    await deps.releaseName().catch((error: unknown) => {
      getImpdLogger('move')
        .with({ imp: imp.name })
        .warning('tailnet name not released yet: {error}', { error: getErrorMessage(error) });
    });

    const response = await sendToPeer(deps, { peer, path: MOVE_PATHS.commit, ticket });
    const answer = await requireOk(response, 'commit');

    const reply = MoveCommitReplySchema.parse(answer);

    if (!reply.isCommitted) {
      throw new Error('commit: the target did not commit');
    }

    try {
      await deps.imps.destroyImp(imp.name, { isMove: true });
    } catch (error) {
      if (!isImpdError(error, 'NOT_FOUND')) {
        throw error;
      }
    }

    await removeMoveSend(deps.db, imp.id);

    getImpdLogger('move')
      .with({ imp: imp.name })
      .info('committed on {peer}; the copy here is gone', { peer });
  };

  const runCommitAfterRestart = async (imp: ImpRecord, peer: string, ticket: string) => {
    try {
      await runCommit(imp, peer, ticket);
    } catch (error) {
      getImpdLogger('move')
        .with({ imp: imp.name })
        .warning('commit after restart: {error}', { error: getErrorMessage(error) });
    }
  };

  const removeMark = async (imp: ImpRecord): Promise<void> => {
    await updateImpMove(deps.db, imp.id, null);
    await removeMoveSend(deps.db, imp.id);
  };

  const resetSend = async (
    imp: ImpRecord,
    peer: string | null,
    ticket: string | null,
  ): Promise<boolean> => {
    if (peer === null || ticket === null) {
      await removeMark(imp);

      return true;
    }

    try {
      await sendMoveAbort(deps, imp, peer, ticket);
    } catch (error) {
      const message = `the target did not confirm the abort (${getErrorMessage(error)}); run impz move ${imp.name} <host> --abort`;

      await updateMoveSend(deps.db, imp.id, { error: message });

      getImpdLogger('move').with({ imp: imp.name }).info('{message}', { message });

      return false;
    }

    await removeMark(imp);

    return true;
  };

  const startHaltedAgain = async (imp: ImpRecord): Promise<void> => {
    try {
      await deps.imps.startImp(imp.name);
    } catch (error) {
      getImpdLogger('move')
        .with({ imp: imp.name })
        .warning('could not start it again: {error}', { error: getErrorMessage(error) });
    }
  };

  const startSend = (imp: ImpRecord, target: SendTarget, totalBytes: number): SendTask => {
    const peer = target.peer;
    const ticket = target.ticket;

    const task: SendTask = {
      abort: new AbortController(),
      done: Promise.resolve(),
      sentBytes: 0,
      totalBytes,
      error: null,
      isDone: false,
    };

    const run = async (): Promise<void> => {
      try {
        await runMoveSend(deps, imp, target, {
          signal: task.abort.signal,
          onData: (bytes) => {
            task.sentBytes += bytes;
          },
        });

        await runCommit(imp, peer, ticket);

        task.isDone = true;
      } catch (error) {
        const message = getErrorMessage(error);

        getImpdLogger('move').with({ imp: imp.name }).info('{message}', { message });

        const fresh = await readImpById(deps.db, imp.id);

        if (fresh?.moveState === 'sending') {
          await resetSend(imp, peer, ticket);
        }

        if (error instanceof OfferRefusalError && halted.has(imp.id)) {
          await startHaltedAgain(imp);
        }

        task.error = message;
      } finally {
        halted.delete(imp.id);
        finished.set(imp.id, { error: task.error, isDone: task.isDone });
        tasks.delete(imp.id);
      }
    };

    tasks.set(imp.id, task);

    task.done = run();

    return task;
  };

  const readStatusOf = async (imp: ImpRecord): Promise<MoveStatus> => {
    // A failed send sets its error and leaves the map in one tick, after the abort
    // wrote the row's; a copy taken after the await could show the task's error
    // while a later read shows the row's.
    const running = tasks.get(imp.id);
    const task = running === undefined ? undefined : { ...running };

    const row = await readMoveSend(deps.db, imp.id);

    const last = finished.get(imp.id);

    return {
      state: imp.moveState,
      peer: row?.peer_url ?? null,
      sentBytes: task?.sentBytes ?? 0,
      totalBytes: task?.totalBytes ?? row?.total_bytes ?? 0,
      isDone: task?.isDone ?? last?.isDone ?? false,
      error: task?.error ?? row?.error ?? last?.error ?? null,
    };
  };

  const writeSendMark = async (
    imp: LockedImp,
    options: PrepareOptions,
    isWarm: boolean,
  ): Promise<MovePlan> => {
    const meta = isWarm ? requireSnapshotMeta(deps, imp) : null;
    const warm = meta === null ? null : await checkWarmMove(deps, imp, meta, options.target);
    const isZfs = deps.storage.kind === 'zfs' && options.targetStorage === 'zfs';
    const mode: MoveMode = isZfs ? 'zfs' : 'files';

    const bytes = await countMoveBytes(deps, imp, mode, meta);

    await writeMoveSend(deps.db, {
      imp_id: imp.id,
      peer_url: null,
      ticket: null,
      total_bytes: bytes,
      mode,
      warm: isWarm ? 1 : 0,
      receipt: null,
      error: null,
      created_at: deps.now(),
    });

    const marked = await updateImpMove(deps.db, imp.id, 'sending');

    if (marked.publicAuth !== null) {
      await removeMark(imp);

      throw buildPublicError(imp.name);
    }

    finished.delete(imp.id);

    const checkpoints = await listCheckpoints(deps.db, imp.id);

    return { bytes, checkpoints: checkpoints.length, warm };
  };

  const writeHaltedMark = async (
    imp: LockedImp,
    stopped: LockedImp,
    options: PrepareOptions,
  ): Promise<MovePlan> => {
    try {
      const plan = await writeSendMark(stopped, options, false);

      if (options.force) {
        await deps.imps.endForcedLeases(stopped);
      }

      return plan;
    } catch (error) {
      await removeMark(imp);

      if (halted.delete(imp.id)) {
        await deps.imps.requireRunningImp(stopped).catch((startError: unknown) => {
          getImpdLogger('move')
            .with({ imp: imp.name })
            .warning('could not start it again: {error}', { error: getErrorMessage(startError) });
        });
      }

      throw error;
    }
  };

  const requirePeer = (to: string): string => {
    const address = parsePeerUrlAddress(to);

    if (address === null || !deps.ranges.isAllowed(address)) {
      throw new ImpdError('BAD_REQUEST', {
        message: `${to}: a move goes only to a literal tailnet address`,
      });
    }

    return to;
  };

  const recovery: { last: Promise<void> } = { last: Promise.resolve() };

  const runRecover = async (): Promise<void> => {
    try {
      for (const imp of await listImps(deps.db)) {
        const row = await readMoveSend(deps.db, imp.id);

        if (imp.moveState === 'sending') {
          const isUndone = await resetSend(imp, row?.peer_url ?? null, row?.ticket ?? null);

          if (isUndone) {
            getImpdLogger('move')
              .with({ imp: imp.name })
              .info('a send cut short by a restart was undone');
          }
        }

        if (
          imp.moveState === 'moved' &&
          row !== undefined &&
          row.peer_url !== null &&
          row.ticket !== null
        ) {
          await runCommitAfterRestart(imp, row.peer_url, row.ticket);
        }
      }
    } catch (error) {
      getImpdLogger('move').warning('recovery after a restart failed: {error}', {
        error: getErrorMessage(error),
      });
    }
  };

  return {
    prepare: (name, options) =>
      deps.imps.lockImp(name, async (imp) => {
        if (imp.publicAuth !== null) {
          throw buildPublicError(name);
        }

        const isWarm = imp.state === 'sleeping' && !options.stop;

        if (isWarm || imp.state === 'stopped') {
          return writeSendMark(imp, options, isWarm);
        }

        if (imp.state !== 'running' && imp.state !== 'sleeping') {
          throw buildInvalidStateError(imp.state, ['stopped'], 'move');
        }

        if (!options.stop) {
          throw buildInvalidStateError(imp.state, ['stopped', 'sleeping'], 'move');
        }

        await deps.imps.requireUnleased(imp, options.force);

        const stopped = await deps.imps.haltImp(imp);

        if (imp.state === 'running') {
          halted.add(imp.id);
        }

        return writeHaltedMark(imp, stopped, options);
      }),

    send: async (name, to, ticket) => {
      const peer = requirePeer(to);

      const imp = await requireImp(name);
      const row = await readMoveSend(deps.db, imp.id);

      if (imp.moveState !== 'sending' || row === undefined || tasks.has(imp.id)) {
        throw new ImpdError('CONFLICT', {
          message: `${name} is not prepared for a send: run moves.prepare first`,
          data: { kind: 'imp' as const, name },
        });
      }

      await updateMoveSend(deps.db, imp.id, { peer_url: peer, ticket });

      startSend(imp, { peer, ticket, mode: row.mode, isWarm: row.warm === 1 }, row.total_bytes);

      return readStatusOf(imp);
    },

    readStatus: async (name) => {
      const imp = await readImpByName(deps.db, name);

      if (imp === undefined) {
        return { state: null, peer: null, sentBytes: 0, totalBytes: 0, isDone: true, error: null };
      }

      return readStatusOf(imp);
    },

    resume: async (name, ticket) => {
      const imp = await requireImp(name);
      const row = await readMoveSend(deps.db, imp.id);

      const useTicket = ticket ?? row?.ticket ?? null;

      if (row === undefined || row.peer_url === null || useTicket === null) {
        throw new ImpdError('CONFLICT', {
          message: `${name} has no move to resume`,
          data: { kind: 'imp' as const, name },
        });
      }

      if (ticket !== undefined) {
        await updateMoveSend(deps.db, imp.id, { ticket });
      }

      if (imp.moveState === 'moved') {
        await withPeerError(() => runCommit(imp, row.peer_url ?? '', useTicket));

        return {
          state: null,
          peer: row.peer_url,
          sentBytes: 0,
          totalBytes: 0,
          isDone: true,
          error: null,
        };
      }

      if (imp.moveState === 'sending' && !tasks.has(imp.id) && ticket !== undefined) {
        startSend(
          imp,
          { peer: row.peer_url, ticket, mode: row.mode, isWarm: row.warm === 1 },
          row.total_bytes,
        );

        return readStatusOf(imp);
      }

      return readStatusOf(imp);
    },

    abort: async (name) => {
      const imp = await requireImp(name);

      const task = tasks.get(imp.id);

      if (task !== undefined) {
        task.abort.abort();

        await task.done;

        const fresh = await readImpById(deps.db, imp.id);

        return readStatusOf(fresh ?? imp);
      }

      const row = await readMoveSend(deps.db, imp.id);

      const peer = row?.peer_url ?? null;
      const ticket = row?.ticket ?? null;
      const isMarked = imp.moveState === 'sending' || imp.moveState === 'moved';

      if (isMarked && peer !== null && ticket !== null) {
        const outcome = await withPeerError(() => sendMoveAbort(deps, imp, peer, ticket));

        if (outcome === 'committed') {
          await withPeerError(() => runCommit(imp, peer, ticket));

          return { state: null, peer, sentBytes: 0, totalBytes: 0, isDone: true, error: null };
        }
      }

      if (isMarked) {
        await removeMark(imp);
      }

      const after = await readImpById(deps.db, imp.id);

      return readStatusOf(after ?? imp);
    },

    recover: () => {
      recovery.last = runRecover();

      return Promise.resolve();
    },
    waitForRecovery: () => recovery.last,
  };
}

function buildPublicError(name: string) {
  return new ImpdError('PRECONDITION_FAILED', {
    message: `${name} is public: run impz unexpose ${name} first, and impz expose on the target after the move`,
  });
}

async function withPeerError<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ImpdError) {
      throw error;
    }

    throw new ImpdError('BAD_GATEWAY', { message: getErrorMessage(error), cause: error });
  }
}
