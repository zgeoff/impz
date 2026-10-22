import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { BackupRestore, BackupRun, BackupStatus, ImpState } from '@impz/api';
import * as z from 'zod';
import type { TokenStore } from '../../identity/auth/token-store';
import type { ImageService } from '../../imps/images/image-service';
import type { LockedImp } from '../../imps/imps/imp-lock';
import type { Imps } from '../../imps/imps/imp-service';
import type { Broker } from '../../network/broker/broker-service';
import type { NetworkService } from '../../network/networks/network-service';
import { parseStoredPolicy } from '../../platform/db/egress';
import type { ImpDatabase } from '../../platform/db/open-database';
import { ImpdError } from '../../platform/errors/impd-error';
import { NOT_BACKED_UP_REASON } from '../../platform/errors/impd-errors';
import { buildBackoffMs } from '../../platform/process/build-backoff-ms';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { buildKeyedMutex } from '../../platform/process/keyed-mutex';
import { printLog } from '../../platform/process/print-log';
import { writeFileDurably } from '../../platform/process/write-file-durably';
import { sendFreeze, sendThaw } from '../../vm/agent-client/agent-requests';
import { FREEZE_TIMEOUT_MS } from '../../vm/checkpoints/consistent-disk';
import type { DiskFreezer } from '../../vm/checkpoints/consistent-disk';
import { BACKUP_TREE, buildBackupPaths } from '../../vm/storage/data-layout';
import type { DiskBudget } from '../../vm/storage/disk-budget';
import type { BackupTree, StorageBackend } from '../../vm/storage/storage-backend';
import type { StorageGate } from '../../vm/storage/storage-gate';
import type { BackupConfig } from './backup-config';
import type { BackupManifest } from './backup-manifest';
import { readDatabaseCopy } from './read-database-copy';
import type { DatabaseCopy } from './read-database-copy';
import { createRestic, isResticLocked } from './restic';
import type { Restic } from './restic';
import { runRestore } from './run-restore';
import type { RestoreInput } from './run-restore';

const DAY_MS = 24 * 60 * 60 * 1000;

// A prune holds restic's exclusive lock, so it runs once a day; a check reads
// packs back from the bucket, so it runs once a week and a part at a time.
const PRUNE_EVERY_MS = DAY_MS;
const CHECK_EVERY_MS = 7 * DAY_MS;
const CHECK_SUBSET = '5%';

// Six ticks of 5 minutes outlast restic's 30 minutes, after which a lock left
// behind is stale and unlock removes it.
const PRUNE_LOCK_TRIES = 6;
const RETRY_FIRST_MS = 5 * 60 * 1000;

const BackupStateSchema = z.object({
  lastRunAt: z.coerce.date().nullable().default(null),
  lastPruneAt: z.coerce.date().nullable().default(null),
  lastCheckAt: z.coerce.date().nullable().default(null),
  lastCheckError: z.string().nullable().default(null),
});

type BackupState = z.infer<typeof BackupStateSchema>;

interface DiskCopy {
  readonly state: ImpState;
  readonly synced: boolean;
}

export interface BackupService {
  readonly runBackup: () => Promise<BackupRun>;
  readonly readStatus: () => Promise<BackupStatus>;
  readonly restoreBackup: (input: RestoreInput) => Promise<BackupRestore>;
  readonly checkBackups: (subset?: string) => Promise<void>;
  readonly runScheduled: () => Promise<void>;
}

export interface BackupServiceDeps {
  readonly dataDir: string;
  readonly backup: BackupConfig;
  readonly db: ImpDatabase;
  readonly imps: Pick<Imps, 'createImp' | 'destroyImp' | 'lockImp'>;
  readonly grants: Pick<Broker, 'addGrant'>;
  readonly tokens: Pick<TokenStore, 'createRestored'>;
  readonly networks: Pick<NetworkService, 'writeMissingNetworks' | 'removeEmptyNetworks'>;
  readonly storage: StorageBackend;
  readonly images: Pick<ImageService, 'withImagePublisher'>;
  readonly restic?: Restic;
  readonly freezer?: DiskFreezer;
  readonly log?: (message: string) => void;
  readonly now?: () => Date;
  readonly storageGate: StorageGate;
  readonly diskBudget: Pick<DiskBudget, 'requireRoom' | 'withRoom'>;
}

export function buildBackupsOffError(): ImpdError<'PRECONDITION_FAILED'> {
  return new ImpdError('PRECONDITION_FAILED', {
    message: 'backups are off: set IMP_BACKUP_REPOSITORY (docs/guides/configuration.md)',
  });
}

interface ReadManifestOptions {
  readonly runId: string;
  readonly copy: DatabaseCopy;
  readonly copies: ReadonlyMap<string, DiskCopy>;
  readonly tree: BackupTree;
  readonly excluded: BackupManifest['excluded'];
  readonly database: BackupManifest['database'];
}

export function createBackupService(deps: BackupServiceDeps): BackupService {
  const log = deps.log ?? printLog;
  const now = deps.now ?? (() => new Date());
  const freezer = deps.freezer ?? { freeze: sendFreeze, thaw: sendThaw };
  const storage = deps.storage;
  const paths = buildBackupPaths(deps.dataDir);
  const restic = deps.restic ?? createRestic({ config: deps.backup, cacheDir: paths.cache });
  const storageGate = deps.storageGate;
  const diskBudget = deps.diskBudget;
  const restoreDeps = { ...deps, restic, paths, log, now };
  const mutex = buildKeyedMutex();
  const runExclusive = <T>(task: () => Promise<T>) => mutex.runExclusive('backup', task);
  const retry = { failures: 0, lastFailureAt: 0, pruneLocks: 0 };

  const probeRunDue = (): boolean => {
    const at = now().getTime();
    const intervalMs = deps.backup.intervalS * 1000;

    if (retry.failures > 0) {
      const waitMs = buildBackoffMs(retry.failures, { baseMs: RETRY_FIRST_MS, capMs: intervalMs });

      return at - retry.lastFailureAt >= waitMs;
    }

    return at - (readState().lastRunAt?.getTime() ?? 0) >= intervalMs;
  };

  const readState = (): BackupState => {
    try {
      return BackupStateSchema.parse(JSON.parse(readFileSync(paths.state, 'utf8')));
    } catch {
      return BackupStateSchema.parse({});
    }
  };

  const writeState = (change: Partial<BackupState>): void => {
    mkdirSync(paths.directoryPath, { recursive: true });
    writeFileDurably(paths.state, JSON.stringify({ ...readState(), ...change }));
  };

  const createCopy = async (imp: LockedImp, runId: string): Promise<DiskCopy> => {
    if (imp.state !== 'running') {
      await storage.createBackupCopy(imp.id, runId, { isReusable: true });

      return { state: imp.state, synced: imp.state === 'stopped' };
    }

    const vsock = storage.resolveImpPaths(imp.id).vsockSocket;

    try {
      await freezer.freeze(vsock, FREEZE_TIMEOUT_MS);
    } catch (error) {
      log(`impd: backup: ${imp.name}: no freeze, copied unsynced: ${getErrorMessage(error)}`);

      await storage.createBackupCopy(imp.id, runId, { isReusable: false });

      return { state: imp.state, synced: false };
    }

    try {
      await storage.createBackupCopy(imp.id, runId, { isReusable: false });
    } finally {
      await freezer.thaw(vsock).catch((error: unknown) => {
        log(
          `impd: backup: ${imp.name}: thaw failed (the agent thaws on its own): ${getErrorMessage(error)}`,
        );
      });
    }

    return { state: imp.state, synced: true };
  };

  // restic restores a sparse disk sparse again, so its blocks measure the room
  // a restore needs.
  const readTreeUsedBytes = (file: string): number => statSync(join(paths.tree, file)).blocks * 512;

  const readManifest = (options: ReadManifestOptions): BackupManifest => {
    const copy = options.copy;
    const copies = options.copies;
    const tree = options.tree;

    const digests = new Map(copy.images.map((image) => [image.id, image.digest]));

    return {
      version: 1,
      runId: options.runId,
      createdAt: now(),
      imps: copy.imps
        .filter((imp) => tree.impIds.has(imp.id))
        .map((imp) => ({
          id: imp.id,
          name: imp.name,
          imageDigest: digests.get(imp.imageId) ?? '',
          vcpus: imp.vcpus,
          memoryMib: imp.memoryMib,
          maxMemoryMib: imp.maxMemoryMib,
          httpPort: imp.httpPort,
          state: copies.get(imp.id)?.state ?? imp.state,
          synced: copies.get(imp.id)?.synced ?? false,
          // oxlint-disable-next-line zgeoff/no-abbreviated-names -- a key of the manifest that backups store
          dir: BACKUP_TREE.buildImpDir(imp.id),
          egressPolicy: parseStoredPolicy(imp.egressPolicy, imp.egressAllow).mode,
          egressAllow: parseStoredPolicy(imp.egressPolicy, imp.egressAllow).allow,
          grants: copy.grants
            .filter((grant) => grant.impId === imp.id && grant.filter === null)
            .map((grant) => grant.secretName),
          filteredGrants: copy.grants.flatMap((grant) =>
            grant.impId === imp.id && grant.filter !== null
              ? [{ secret: grant.secretName, filter: grant.filter }]
              : [],
          ),
          identityResetPending: imp.identityResetPending === 1,
          networks: copy.members
            .filter((member) => member.impId === imp.id)
            .map((member) => member.network),
          disk: BACKUP_TREE.buildDisk(imp.id),
          diskBytes: imp.diskBytes,
          usedBytes: readTreeUsedBytes(BACKUP_TREE.buildDisk(imp.id)),
          checkpoints: copy.checkpoints
            .filter(
              (checkpoint) => checkpoint.impId === imp.id && tree.checkpointIds.has(checkpoint.id),
            )
            .map((checkpoint) => ({
              id: checkpoint.id,
              label: checkpoint.label,
              createdAt: new Date(checkpoint.createdAt),
              disk: BACKUP_TREE.buildCheckpointDisk(imp.id, checkpoint.id),
              diskBytes: checkpoint.diskBytes,
              usedBytes: readTreeUsedBytes(BACKUP_TREE.buildCheckpointDisk(imp.id, checkpoint.id)),
            })),
        })),
      excluded: options.excluded,
      images: copy.images
        .filter((image) => tree.imageDigests.has(image.digest))
        .map((image) => ({
          name: image.name,
          ref: image.ref,
          digest: image.digest,
          source: image.source,
          sourceImp: image.sourceImp,
          sizeBytes: image.sizeBytes,
          // oxlint-disable-next-line zgeoff/no-abbreviated-names -- a key of the manifest that backups store
          dir: BACKUP_TREE.buildImageDir(image.digest),
        })),
      database: options.database,
    };
  };

  const runBackup = async (): Promise<BackupRun> => {
    await diskBudget.requireRoom(0);

    return storageGate.join(runJoinedBackup);
  };

  const runJoinedBackup = async (): Promise<BackupRun> => {
    const started = performance.now();
    const runId = Bun.randomUUIDv7();

    await restic.setupRepository();

    // A lock a crashed prune left would block the run.
    await restic.unlock();

    const copyPath = join(paths.directoryPath, 'db.sqlite');

    const copy = await readDatabaseCopy(deps.db, copyPath);

    const copies = new Map<string, DiskCopy>();

    const skipped: { name: string; reason: string }[] = [];

    const excluded = copy.imps
      .filter((imp) => imp.backup === 0)
      .map((imp) => ({ name: imp.name, reason: NOT_BACKED_UP_REASON }));

    for (const imp of copy.imps) {
      if (imp.backup === 0) {
        continue;
      }

      if (imp.state === 'creating') {
        skipped.push({ name: imp.name, reason: 'being created' });
        continue;
      }

      try {
        const made = await deps.imps.lockImp(imp.name, (locked) =>
          locked.id === imp.id
            ? createCopy(locked, runId)
            : Promise.reject(new Error('replaced since the database copy')),
        );

        copies.set(imp.id, made);
      } catch (error) {
        skipped.push({ name: imp.name, reason: getErrorMessage(error) });

        log(`impd: backup: ${imp.name}: left out: ${getErrorMessage(error)}`);
      }
    }

    const tree = await storage.openBackupTree({
      runId,
      imps: copy.imps
        .filter((imp) => copies.has(imp.id))
        .map((imp) => ({
          impId: imp.id,
          checkpointIds: copy.checkpoints
            .filter((checkpoint) => checkpoint.impId === imp.id)
            .map((checkpoint) => checkpoint.id),
        })),
      imageDigests: copy.images.map((image) => image.digest),
    });

    const database = deps.backup.database
      ? { file: BACKUP_TREE.database, sizeBytes: statSync(copyPath).size }
      : null;

    const manifest = readManifest({ runId, copy, copies, tree, excluded, database });

    try {
      mkdirSync(paths.tree, { recursive: true });

      await writeTreeDatabase(copyPath, database);

      writeFileSync(join(paths.tree, BACKUP_TREE.manifest), JSON.stringify(manifest, null, 2));

      const names = manifest.imps.map((imp) => imp.name);

      const summary = await restic.backup(paths.tree, [
        `run=${runId}`,
        ...names.map((name) => `imp=${name}`),
        ...excluded.map((imp) => `excluded=${imp.name}`),
      ]);

      writeState({ lastRunAt: now() });

      retry.failures = 0;

      if (deps.backup.forget) {
        await restic.forget(deps.backup.keep);
      }

      return {
        snapshotId: summary.snapshotId,
        imps: names,
        skipped,
        excluded,
        dataAddedBytes: summary.dataAddedBytes,
        durationMs: Math.round(performance.now() - started),
      };
    } finally {
      await tree.close();
    }
  };

  const writeTreeDatabase = async (
    copyPath: string,
    database: BackupManifest['database'],
  ): Promise<void> => {
    rmSync(join(paths.tree, dirname(BACKUP_TREE.database)), { recursive: true, force: true });

    if (database === null) {
      return;
    }

    const target = join(paths.tree, database.file);

    await diskBudget.withRoom(database.sizeBytes, () => {
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      copyFileSync(copyPath, target);
      chmodSync(target, 0o600);

      return Promise.resolve();
    });
  };

  const runCheck = async (subset: string): Promise<void> => {
    await restic.unlock();

    try {
      await restic.check(subset);

      writeState({ lastCheckAt: now(), lastCheckError: null });
    } catch (error) {
      const message = getErrorMessage(error);

      writeState({ lastCheckAt: now(), lastCheckError: message });
      log(`impd: backup: CHECK FAILED, the repository may be damaged: ${message}`);
      throw error;
    }
  };

  const runPrune = async (): Promise<void> => {
    try {
      await restic.unlock();
      await restic.prune();

      retry.pruneLocks = 0;

      writeState({ lastPruneAt: now() });
    } catch (error) {
      retry.pruneLocks = isResticLocked(error) ? retry.pruneLocks + 1 : 0;

      log(`impd: backup: PRUNE FAILED: ${getErrorMessage(error)}`);
    }
  };

  const runMaintenance = async (): Promise<void> => {
    const state = readState();
    const at = now().getTime();

    if (deps.backup.forget && at - (state.lastPruneAt?.getTime() ?? 0) >= PRUNE_EVERY_MS) {
      retry.pruneLocks = 0;

      await runPrune();
    }

    if (at - (state.lastCheckAt?.getTime() ?? 0) >= CHECK_EVERY_MS) {
      await runCheck(CHECK_SUBSET).catch(() => {});
    }
  };

  return {
    runBackup: () => runExclusive(runBackup),

    readStatus: async () => {
      const points = await restic.listSnapshots();

      const state = readState();

      return {
        points: points.map((point) => ({
          id: point.id,
          time: point.time,
          imps: point.tags.filter((tag) => tag.startsWith('imp=')).map((tag) => tag.slice(4)),
        })),
        lastRunAt: state.lastRunAt,
        lastPruneAt: state.lastPruneAt,
        lastCheck:
          state.lastCheckAt === null
            ? null
            : {
                at: state.lastCheckAt,
                ...(state.lastCheckError !== null && { error: state.lastCheckError }),
              },
      };
    },

    restoreBackup: (input) => runExclusive(() => runRestore(restoreDeps, input)),

    checkBackups: (subset) => runExclusive(() => runCheck(subset ?? CHECK_SUBSET)),

    runScheduled: () =>
      runExclusive(async () => {
        if (!probeRunDue()) {
          if (retry.pruneLocks > 0 && retry.pruneLocks < PRUNE_LOCK_TRIES) {
            await runPrune();
          }

          return;
        }

        try {
          const run = await runBackup().catch((error: unknown) => {
            retry.failures += 1;
            retry.lastFailureAt = now().getTime();
            throw error;
          });

          retry.failures = 0;

          const skipped = run.skipped.length > 0 ? `, ${String(run.skipped.length)} left out` : '';

          log(
            `impd: backup: ${run.snapshotId}: ${String(run.imps.length)} imps${skipped}, ${String(run.dataAddedBytes)} bytes added in ${String(run.durationMs)}ms`,
          );
        } finally {
          await runMaintenance();
        }
      }),
  };
}
