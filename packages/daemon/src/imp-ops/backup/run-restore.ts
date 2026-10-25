import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BackupRestore, Imp } from '@impz/api';
import type { TokenStore } from '../../identity/auth/token-store';
import type { ImageService } from '../../imps/images/image-service';
import type { Imps } from '../../imps/imps/imp-service';
import type { NetworkService } from '../../network/networks/network-service';
import { listImps, readImpByName } from '../../platform/db/imps';
import type { ImpDatabase } from '../../platform/db/open-database';
import { ImpdError } from '../../platform/errors/impd-error';
import {
  buildConflictError,
  buildNotBackedUpError,
  buildNotFoundError,
} from '../../platform/errors/impd-errors';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import { BACKUP_TREE } from '../../vm/storage/data-layout';
import type { buildBackupPaths } from '../../vm/storage/data-layout';
import type { DiskBudget } from '../../vm/storage/disk-budget';
import type { StorageBackend } from '../../vm/storage/storage-backend';
import type { StorageGate } from '../../vm/storage/storage-gate';
import { writeChangedBlocks } from '../../vm/storage/write-changed-blocks';
import type { ImpGrants } from '../imp-grants';
import { createImageFromFile } from '../imp-import/create-image-from-file';
import type { ImageImportDeps } from '../imp-import/create-image-from-file';
import { readImageInUse } from '../imp-import/read-image-in-use';
import { replayCheckpoints } from '../imp-import/replay-checkpoints';
import { resolveImportedImageName } from '../imp-import/resolve-imported-image-name';
import { resolveImportedPolicy } from '../imp-import/resolve-imported-policy';
import { restoreGrants } from '../imp-import/restore-grants';
import { BackupManifestSchema } from './backup-manifest';
import type { BackupManifest, ManifestImage, ManifestImp } from './backup-manifest';
import { createRestoredAccess } from './create-restored-access';
import type { Restic, ResticSnapshot } from './restic';

export interface RestoreInput {
  readonly name?: string | undefined;
  readonly all?: boolean | undefined;
  readonly at?: Date | undefined;
  readonly as?: string | undefined;
  readonly merge?: boolean | undefined;
}

export interface RestoreDeps {
  readonly db: ImpDatabase;
  readonly imps: Pick<Imps, 'createImp' | 'destroyImp'>;
  readonly grants: Pick<ImpGrants, 'addGrant'>;
  readonly tokens: Pick<TokenStore, 'createRestored'>;
  readonly networks: Pick<NetworkService, 'writeMissingNetworks' | 'removeEmptyNetworks'>;
  readonly storage: Pick<
    StorageBackend,
    'createImage' | 'createCheckpoint' | 'createImpDisk' | 'resolveImpPaths'
  >;
  readonly images: Pick<ImageService, 'withImagePublisher'>;
  readonly restic: Pick<Restic, 'unlock' | 'listSnapshots' | 'dump' | 'restore'>;
  readonly paths: Pick<ReturnType<typeof buildBackupPaths>, 'tree' | 'restoreDir'>;
  readonly storageGate: Pick<StorageGate, 'join'>;
  readonly diskBudget: Pick<DiskBudget, 'withRoom'>;
  readonly now: () => Date;
  readonly writeImageFiles: ImageImportDeps['writeImageFiles'];
}

type SkippedGrant = BackupRestore['skippedGrants'][number];

export async function runRestore(deps: RestoreDeps, input: RestoreInput): Promise<BackupRestore> {
  if ((input.all === true) === (input.name !== undefined)) {
    throw new ImpdError('BAD_REQUEST', { message: 'restore one imp by name, or all of them' });
  }

  if (input.all === true && input.as !== undefined) {
    throw new ImpdError('BAD_REQUEST', { message: '`as` renames one imp, not all of them' });
  }

  // A stale lock from a crashed run would block even reading the repository.
  await deps.restic.unlock();

  const point = await readPoint(deps, input.at ?? deps.now(), input.name);

  const base = point.paths[0] ?? deps.paths.tree;

  const manifestText = await deps.restic.dump(point.id, join(base, BACKUP_TREE.manifest));

  const manifest = BackupManifestSchema.parse(JSON.parse(manifestText));
  const chosen = manifest.imps.filter((imp) => input.all === true || imp.name === input.name);

  const notRestorable = manifest.excluded
    .filter((imp) => input.all === true || imp.name === input.name)
    .map((imp) => ({ imp: imp.name, reason: imp.reason }));

  if (input.name !== undefined && chosen.length === 0 && notRestorable.length > 0) {
    throw buildNotBackedUpError(
      input.name,
      `backup ${point.id} (${point.time.toISOString()}) holds none of its files`,
    );
  }

  const present = await listImps(deps.db);

  const presentNames = new Set(present.map((imp) => imp.name));

  if (input.all === true && present.length > 0 && input.merge !== true) {
    throw new ImpdError('PRECONDITION_FAILED', {
      message: `impd has ${String(present.length)} imps already; restore --all --merge adds the backup's imps to them`,
    });
  }

  for (const imp of chosen) {
    const name = input.as ?? imp.name;

    if (presentNames.has(name)) {
      throw buildConflictError(
        'imp',
        name,
        `an imp named ${name} exists; restore it --as another name`,
      );
    }
  }

  const workDir = join(deps.paths.restoreDir, Bun.randomUUIDv7());
  const restored: Imp[] = [];
  const skippedGrants: SkippedGrant[] = [];

  try {
    const database =
      input.all === true && manifest.database !== null
        ? await createRestoredDatabase(deps, {
            point,
            base,
            database: manifest.database,
            workDir,
          })
        : undefined;

    const imageNames = new Map<string, string>();

    const templates = manifest.images.filter((image) => image.source === 'imp');

    const digests = new Set([
      ...chosen.map((imp) => imp.imageDigest),
      ...(input.all === true ? templates.map((image) => image.digest) : []),
    ]);

    for (const digest of digests) {
      const image = manifest.images.find((candidate) => candidate.digest === digest);

      if (image === undefined) {
        throw new Error(`the backup holds no image ${digest}`);
      }

      const imageName = await createRestoredImage(deps, { point, base, image, workDir });

      imageNames.set(digest, imageName);
    }

    for (const imp of chosen) {
      const target = { name: input.as ?? imp.name, image: imageNames.get(imp.imageDigest) ?? '' };

      const created = await createRestoredImp(deps, { point, base, imp, target, workDir });

      restored.push(created);

      const skipped = await restoreGrants(deps, target.name, imp);

      skippedGrants.push(
        ...skipped.map((grant) => ({
          imp: target.name,
          secret: grant.secret,
          reason: grant.reason,
        })),
      );

      getImpdLogger('backup')
        .with({ imp: target.name })
        .info('restored from {id} ({time})', { id: point.id, time: point.time.toISOString() });
    }

    return {
      imps: restored,
      skippedGrants,
      notRestorable,
      ...(database !== undefined && { database }),
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function readPoint(
  deps: RestoreDeps,
  at: Date,
  name: string | undefined,
): Promise<ResticSnapshot> {
  const points = await deps.restic.listSnapshots();

  const point = points.findLast(
    (candidate) =>
      candidate.time.getTime() <= at.getTime() &&
      (name === undefined ||
        candidate.tags.includes(`imp=${name}`) ||
        candidate.tags.includes(`excluded=${name}`)),
  );

  if (point === undefined) {
    throw buildNotFoundError('backup', `${name ?? 'any imp'} at ${at.toISOString()}`);
  }

  return point;
}

interface CreateRestoredDatabaseOptions {
  readonly point: ResticSnapshot;
  readonly base: string;
  readonly database: NonNullable<BackupManifest['database']>;
  readonly workDir: string;
}

async function createRestoredDatabase(deps: RestoreDeps, options: CreateRestoredDatabaseOptions) {
  const point = options.point;
  const base = options.base;
  const database = options.database;
  const workDir = options.workDir;
  const file = requireTreeDatabase(database.file);
  const directory = join(workDir, dirname(file));

  const access = await deps.diskBudget.withRoom(database.sizeBytes, async () => {
    await deps.restic.restore(point.id, join(base, dirname(file)), directory, []);

    return createRestoredAccess(deps.db, deps.tokens, join(workDir, file));
  });

  getImpdLogger('backup').info('restored {tokens} tokens and {secrets} secrets from {id}', {
    tokens: String(access.tokens.length),
    secrets: String(access.secrets.length),
    id: point.id,
  });

  return access;
}

// An altered manifest could name another path, which would restore a file
// outside the restore's directory.
function requireTreeDatabase(database: string): string {
  if (database !== BACKUP_TREE.database) {
    throw new Error(
      `the backup names its database copy at ${database}, not ${BACKUP_TREE.database}`,
    );
  }

  return database;
}

interface CreateRestoredImageOptions {
  readonly point: ResticSnapshot;
  readonly base: string;
  readonly image: ManifestImage;
  readonly workDir: string;
}

function createRestoredImage(
  deps: RestoreDeps,
  options: CreateRestoredImageOptions,
): Promise<string> {
  return deps.storageGate.join(() =>
    deps.diskBudget.withRoom(2 * options.image.sizeBytes, () => createJoinedImage(deps, options)),
  );
}

async function createJoinedImage(
  deps: RestoreDeps,
  options: CreateRestoredImageOptions,
): Promise<string> {
  const point = options.point;
  const base = options.base;
  const image = options.image;
  const workDir = options.workDir;

  const existing = await readImageInUse(deps.db, [image.digest], deps.now().getTime());

  if (existing !== undefined) {
    return existing.name;
  }

  // The name check goes before the download, so a taken name fails the restore early.
  await resolveImportedImageName(deps.db, image.name, image.digest);

  const directory = join(workDir, image.dir);

  await deps.restic.restore(point.id, join(base, image.dir), directory, []);

  try {
    return await createImageFromFile(
      { ...deps, now: () => deps.now().getTime() },
      {
        name: image.name,
        ref: image.ref,
        digest: image.digest,
        sizeBytes: image.sizeBytes,
        source: image.source,
        sourceImp: image.sourceImp,
        rootfsPath: join(directory, 'rootfs.ext4'),
        configPath: join(directory, 'config.json'),
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

interface RestoreTarget {
  readonly name: string;
  readonly image: string;
}

interface RestoredSizes {
  readonly diskBytes: number;
  readonly usedBytes?: number | undefined;
}

interface CreateRestoredImpOptions {
  readonly point: ResticSnapshot;
  readonly base: string;
  readonly imp: ManifestImp;
  readonly target: RestoreTarget;
  readonly workDir: string;
}

async function createRestoredImp(
  deps: RestoreDeps,
  options: CreateRestoredImpOptions,
): Promise<Imp> {
  const point = options.point;
  const base = options.base;
  const imp = options.imp;
  const target = options.target;
  const workDir = options.workDir;
  const created = { id: null as string | null };

  const writeRestoredFile = (file: string, disk: string, sizes: RestoredSizes) => {
    const bytes = sizes.usedBytes === undefined ? sizes.diskBytes : 2 * sizes.usedBytes;

    return deps.diskBudget.withRoom(bytes, async () => {
      const fileDir = dirname(file);

      await deps.restic.restore(point.id, join(base, fileDir), join(workDir, fileDir), []);

      try {
        await writeChangedBlocks(join(workDir, file), disk);
      } finally {
        rmSync(join(workDir, fileDir), { recursive: true, force: true });
      }
    });
  };

  const writeRestoredDisk = async (impId: string) => {
    created.id = impId;

    const disk = await replayCheckpoints(deps, {
      impId,
      checkpoints: imp.checkpoints,
      writeCheckpoint: (checkpoint, _index, replayed) =>
        writeRestoredFile(checkpoint.disk, replayed, checkpoint),
    });

    await writeRestoredFile(imp.disk, disk, imp);
  };

  const networks = await deps.networks.writeMissingNetworks(imp.networks);

  try {
    return await deps.imps.createImp({
      name: target.name,
      networkIds: networks.ids,
      image: target.image,
      vcpus: imp.vcpus,
      memoryMib: imp.memoryMib,
      maxMemoryMib: imp.maxMemoryMib ?? undefined,
      httpPort: imp.httpPort,
      policy: resolveImportedPolicy({
        mode: imp.egressPolicy,
        allow: imp.egressAllow,
        onUnknown: (mode) => {
          getImpdLogger('backup')
            .with({ imp: target.name })
            .warning('unknown egress policy {egressPolicy}; imported as none', {
              egressPolicy: JSON.stringify(mode),
            });
        },
      }),
      isIdentityResetPending: imp.identityResetPending,
      start: false,
      prepareDisk: writeRestoredDisk,
    });
  } catch (error) {
    await removeFailedImp(deps, target.name, created.id);

    await deps.networks.removeEmptyNetworks(networks.created);

    throw error;
  }
}

async function removeFailedImp(
  deps: RestoreDeps,
  name: string,
  impId: string | null,
): Promise<void> {
  const found = await readImpByName(deps.db, name);

  if (impId === null || found?.id !== impId) {
    return;
  }

  await deps.imps.destroyImp(name).catch((error: unknown) => {
    getImpdLogger('backup')
      .with({ imp: name })
      .warning('a failed restore left the imp: {error}', { error: getErrorMessage(error) });
  });
}
