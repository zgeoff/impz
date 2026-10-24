import { rmSync } from 'node:fs';
import type { Checkpoint, Imp } from '@impz/api';
import { createConsistentDisk } from '../../imps/imps/consistent-disk';
import type { DiskFreezer } from '../../imps/imps/consistent-disk';
import { toLockedImp } from '../../imps/imps/imp-lock';
import type { ImpCheckpointHooks } from '../../imps/imps/imp-service';
import { updateLockedImpState } from '../../imps/imps/update-locked-imp-state';
import {
  createCheckpoint,
  listCheckpoints,
  readCheckpoint,
  removeCheckpoint,
  toApiCheckpoint,
} from '../../platform/db/checkpoints';
import type { CheckpointRecord } from '../../platform/db/checkpoints';
import { writeNextBootCause } from '../../platform/db/cold-boots';
import { readEgressPolicy } from '../../platform/db/egress';
import { readImpByName, updateImpDisk } from '../../platform/db/imps';
import type { ImpRecord } from '../../platform/db/imps';
import type { ImpDatabase } from '../../platform/db/open-database';
import { ImpdError, isImpdError } from '../../platform/errors/impd-error';
import {
  buildConflictError,
  buildInvalidStateError,
  buildNotFoundError,
} from '../../platform/errors/impd-errors';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import type { DiskBudget } from '../../vm/storage/disk-budget';
import { CheckpointIdTakenError } from '../../vm/storage/storage-backend';
import type { StorageBackend } from '../../vm/storage/storage-backend';
import type { ImpOpsConfig } from '../imp-ops-config';

/* @internal */
export const CHECKPOINT_ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const CHECKPOINT_ID_PREFIX = 'cp-';
const ID_ATTEMPTS = 3;

interface ForkInput {
  readonly source: string;
  readonly name: string;
  readonly checkpoint?: string | undefined;
}

export interface CheckpointService {
  readonly createCheckpoint: (name: string, label: string | undefined) => Promise<Checkpoint>;
  readonly listCheckpoints: (name: string) => Promise<Checkpoint[]>;
  readonly removeCheckpoint: (name: string, ref: string) => Promise<void>;
  readonly restoreCheckpoint: (name: string, ref: string) => Promise<Imp>;

  // Disk only, because a memory fork would duplicate entropy and IDs.
  readonly forkImp: (input: ForkInput) => Promise<ForkedImp>;
}

interface ForkedImp {
  readonly imp: Imp;
  readonly sourceId: string;
}

export interface CheckpointServiceDeps {
  readonly config: ImpOpsConfig;
  readonly db: ImpDatabase;
  readonly imps: ImpCheckpointHooks;
  readonly storage: StorageBackend;
  readonly freezer?: DiskFreezer;
  readonly diskBudget: Pick<DiskBudget, 'requireRoom'>;
  readonly random?: () => number;
}

export function buildCheckpointId(random: () => number = Math.random): string {
  const picks = Array.from({ length: 6 }, () =>
    Math.floor(random() * CHECKPOINT_ID_ALPHABET.length),
  );

  return CHECKPOINT_ID_PREFIX + picks.map((pick) => CHECKPOINT_ID_ALPHABET[pick]).join('');
}

/* @internal */
export function isValidCheckpointLabel(label: string): boolean {
  return !label.startsWith(CHECKPOINT_ID_PREFIX);
}

export function createCheckpointService(deps: CheckpointServiceDeps): CheckpointService {
  const removeRefusedFork = async (name: string, forkId: string | null): Promise<void> => {
    if (forkId === null) {
      return;
    }

    await deps.imps.destroyImpId(forkId).catch((error: unknown) => {
      getImpdLogger('imps')
        .with({ imp: name })
        .warning('a refused fork left the imp: {error}', { error: getErrorMessage(error) });
    });
  };

  const storage = deps.storage;

  const withConsistentDisk = createConsistentDisk({
    storage,
    imps: deps.imps,
    freezer: deps.freezer,
  });

  const readCheckpointOrThrow = async (imp: ImpRecord, ref: string): Promise<CheckpointRecord> => {
    const checkpoint = await readCheckpoint(deps.db, imp.id, ref);

    if (checkpoint === undefined) {
      throw buildNotFoundError('checkpoint', ref);
    }

    return checkpoint;
  };

  // On ZFS an id can still be taken by the snapshot of a deleted checkpoint
  // that a fork needs; the database alone cannot tell.
  const createWithFreshId = async (impId: string) => {
    for (let attempt = 1; ; attempt += 1) {
      const id = buildCheckpointId(deps.random);

      try {
        const sizeBytes = await storage.createCheckpoint(impId, id);

        return { id, sizeBytes };
      } catch (error) {
        if (!(error instanceof CheckpointIdTakenError) || attempt >= ID_ATTEMPTS) {
          throw error;
        }
      }
    }
  };

  return {
    createCheckpoint: (name, label) =>
      deps.imps.lockImp(name, async (imp) => {
        if (label !== undefined) {
          if (!isValidCheckpointLabel(label)) {
            throw new ImpdError('BAD_REQUEST', {
              message: `a label must not start with ${CHECKPOINT_ID_PREFIX}`,
            });
          }

          const taken = await readCheckpoint(deps.db, imp.id, label);

          if (taken !== undefined) {
            throw buildConflictError('checkpoint', label);
          }
        }

        const started = performance.now();

        await deps.diskBudget.requireRoom(0);

        const created = await withConsistentDisk(imp, 'checkpoint', () =>
          createWithFreshId(imp.id),
        );

        const id = created.id;

        try {
          const checkpoint = await createCheckpoint(deps.db, {
            id,
            impId: imp.id,
            label: label ?? null,
            sizeBytes: created.sizeBytes,
            diskBytes: imp.diskBytes,
          });

          const durationMs = Math.round(performance.now() - started);

          getImpdLogger('imps')
            .with({ imp: imp.name })
            .info('checkpoint {id} in {durationMs}ms', { id, durationMs: String(durationMs) });

          return toApiCheckpoint(checkpoint);
        } catch (error) {
          await storage.removeCheckpoint(imp.id, id);

          throw error;
        }
      }),

    listCheckpoints: async (name) => {
      const imp = await readImpByName(deps.db, name);

      if (imp === undefined) {
        throw buildNotFoundError('imp', name);
      }

      const checkpoints = await listCheckpoints(deps.db, imp.id);

      return checkpoints.map((checkpoint) => toApiCheckpoint(checkpoint));
    },

    removeCheckpoint: (name, ref) =>
      deps.imps.lockImp(name, async (imp) => {
        const checkpoint = await readCheckpointOrThrow(imp, ref);

        await removeCheckpoint(deps.db, checkpoint.id);

        await storage.removeCheckpoint(imp.id, checkpoint.id);
      }),

    restoreCheckpoint: (name, ref) =>
      deps.imps.lockImp(name, async (imp) => {
        const checkpoint = await readCheckpointOrThrow(imp, ref);

        if (imp.state === 'creating') {
          throw buildInvalidStateError(
            imp.state,
            ['running', 'sleeping', 'stopped', 'error'],
            'restore',
          );
        }

        const paths = storage.resolveImpPaths(imp.id);
        const wasAwake = imp.state === 'running' || imp.state === 'sleeping';
        const started = performance.now();

        const halted = await storage.restoreCheckpoint(imp.id, checkpoint.id, async () => {
          const stopped = await deps.imps.haltImp(imp, false);

          // The memory holds the old disk's page cache, so it must never pair
          // with the new disk, even after a crash.
          rmSync(paths.snapshotDir, { recursive: true, force: true });

          return stopped;
        });

        const resized = await updateImpDisk(deps.db, imp.id, {
          diskBytes: checkpoint.diskBytes,
          isGrowPending: false,
        });

        const sized = toLockedImp(halted, resized);

        if (!wasAwake) {
          await writeNextBootCause(deps.db, imp.id, 'restore');
        }

        const booted = wasAwake ? await deps.imps.bootImp(sized) : sized;
        const durationMs = Math.round(performance.now() - started);

        const restored = await updateLockedImpState(deps.db, booted, {
          reason: 'restored',
          detail: { durationMs, trigger: checkpoint.id },
          state: booted.state,
        });

        getImpdLogger('imps')
          .with({ imp: imp.name })
          .info('restored {id} in {durationMs}ms', {
            id: checkpoint.id,
            durationMs: String(durationMs),
          });

        return deps.imps.toApi(restored);
      }),

    forkImp: async (input) => {
      const source = await deps.imps.lockImp(input.source, async (imp) => {
        const policy = await readEgressPolicy(deps.db, imp.id);

        if (input.checkpoint !== undefined) {
          await readCheckpointOrThrow(imp, input.checkpoint);
        } else if (imp.state === 'creating') {
          throw buildInvalidStateError(
            imp.state,
            ['running', 'sleeping', 'stopped', 'error'],
            'fork',
          );
        }

        const api = await deps.imps.toApi(imp);

        return {
          imp: api,
          policy,
          isIdentityResetPending: imp.isIdentityResetPending,
          isBackedUp: imp.isBackedUp,
        };
      });

      const made = { forkId: null as string | null, isSourceChanged: false };

      const requireSameSource = (imp: Readonly<ImpRecord> | null): void => {
        if (imp === null || imp.id !== source.imp.id) {
          made.isSourceChanged = true;
          throw buildSourceChangedError(input.source);
        }
      };

      const createForkDisk = async (impId: string) => {
        made.forkId = impId;

        try {
          await deps.imps.lockImp(input.source, async (imp) => {
            requireSameSource(imp);

            if (input.checkpoint === undefined) {
              await withConsistentDisk(imp, 'fork', () =>
                storage.createImpDisk(impId, { kind: 'imp', impId: imp.id }),
              );

              return;
            }

            const checkpoint = await readCheckpointOrThrow(imp, input.checkpoint);

            await storage.createImpDisk(impId, {
              kind: 'checkpoint',
              impId: imp.id,
              checkpointId: checkpoint.id,
            });
          });
        } catch (error) {
          if (isImpNotFound(error)) {
            requireSameSource(null);
          }

          throw error;
        }
      };

      try {
        const fork = await deps.imps.createImp({
          name: input.name,
          image: source.imp.image,
          vcpus: source.imp.vcpus,
          memoryMib: source.imp.memoryMib,
          maxMemoryMib: source.imp.maxMemoryMib,
          policy: source.policy,
          ...(source.imp.cpu !== undefined && {
            cpuLimit: source.imp.cpu.limit,
            cpuWeight: source.imp.cpu.weight,
          }),
          isIdentityResetPending: source.isIdentityResetPending,
          isBackedUp: source.isBackedUp,
          prepareDisk: createForkDisk,
        });

        return { imp: fork, sourceId: source.imp.id };
      } catch (error) {
        if (made.isSourceChanged) {
          await removeRefusedFork(input.name, made.forkId);
        }

        throw error;
      }
    },
  };
}

function buildSourceChangedError(source: string) {
  return buildConflictError(
    'imp',
    source,
    `imp ${source} changed during the fork; the fork was not made`,
  );
}

function isImpNotFound(error: unknown): boolean {
  if (!isImpdError(error, 'NOT_FOUND')) {
    return false;
  }

  const data: unknown = error.data;

  return typeof data === 'object' && data !== null && Reflect.get(data, 'kind') === 'imp';
}
