import { copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EgressPolicySchema } from '@impz/api';
import type { BackupRestore, EgressPolicy, Imp } from '@impz/api';
import { ORPCError } from '@orpc/server';
import { buildConflictError, buildNotBackedUpError, buildNotFoundError } from '../api-errors';
import type { TokenStore } from '../auth/token-store';
import type { Broker } from '../broker/broker-service';
import { buildCheckpointId } from '../checkpoints/checkpoint-service';
import { createCheckpoint } from '../db/checkpoints';
import { createImage, findImageByDigest, findImageByName } from '../db/images';
import { findImpByName, listImps } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import type { Imps } from '../imps/imp-service';
import type { NetworkService } from '../networks/network-service';
import { readErrorMessage } from '../read-error-message';
import { BACKUP_TREE } from '../storage/data-layout';
import type { buildBackupPaths } from '../storage/data-layout';
import type { DiskBudget } from '../storage/disk-budget';
import { CheckpointIdTakenError } from '../storage/storage-backend';
import type { StorageBackend } from '../storage/storage-backend';
import type { StorageGate } from '../storage/storage-gate';
import { BackupManifestSchema } from './backup-manifest';
import type { BackupManifest, ManifestImage, ManifestImp } from './backup-manifest';
import { buildDigestTag } from './build-digest-tag';
import { createRestoredAccess } from './create-restored-access';
import type { Restic, ResticSnapshot } from './restic';
import { writeChangedBlocks } from './write-changed-blocks';

export interface RestoreInput {
  readonly name?: string | undefined;
  readonly all?: boolean | undefined;
  readonly at?: Date | undefined;
  readonly as?: string | undefined;
  readonly merge?: boolean | undefined;
}

// what a restore reads from the backup service, its defaults resolved
export interface RestoreDeps {
  readonly db: ImpDatabase;
  readonly imps: Pick<Imps, 'createImp' | 'destroyImp'>;
  readonly grants: Pick<Broker, 'addGrant'>;
  readonly tokens: Pick<TokenStore, 'createRestored'>;
  readonly networks: Pick<NetworkService, 'writeMissingNetworks' | 'removeEmptyNetworks'>;
  readonly storage: Pick<
    StorageBackend,
    'createImage' | 'createCheckpoint' | 'createImpDisk' | 'resolveImpPaths'
  >;
  readonly restic: Pick<Restic, 'unlock' | 'listSnapshots' | 'dump' | 'restore'>;
  readonly paths: Pick<ReturnType<typeof buildBackupPaths>, 'tree' | 'restoreDir'>;
  readonly storageGate: Pick<StorageGate, 'join'>;
  readonly diskBudget: Pick<DiskBudget, 'withRoom'>;
  readonly log: (message: string) => void;
  readonly now: () => Date;
}

type SkippedGrant = BackupRestore['skippedGrants'][number];

export async function runRestore(deps: RestoreDeps, input: RestoreInput): Promise<BackupRestore> {
  if ((input.all === true) === (input.name !== undefined)) {
    throw new ORPCError('BAD_REQUEST', { message: 'restore one imp by name, or all of them' });
  }

  if (input.all === true && input.as !== undefined) {
    throw new ORPCError('BAD_REQUEST', { message: '`as` renames one imp, not all of them' });
  }

  // a stale lock from a crashed run would block even reading the repository
  await deps.restic.unlock();

  const point = await findPoint(deps, input.at ?? deps.now(), input.name);

  const base = point.paths[0] ?? deps.paths.tree;

  const manifestText = await deps.restic.dump(point.id, join(base, BACKUP_TREE.manifest));

  const manifest = BackupManifestSchema.parse(JSON.parse(manifestText));
  const chosen = manifest.imps.filter((imp) => input.all === true || imp.name === input.name);

  // the backup names these imps but holds none of their files
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
    throw new ORPCError('PRECONDITION_FAILED', {
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
    // before the imps, so their grants find the secrets by name
    const database =
      input.all === true && manifest.database !== null
        ? await createRestoredDatabase(deps, point, base, manifest.database, workDir)
        : undefined;

    const imageNames = new Map<string, string>();

    // images before the imps on them; with all, every template too
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

      const imageName = await createRestoredImage(deps, point, base, image, workDir);

      imageNames.set(digest, imageName);
    }

    for (const imp of chosen) {
      const target = { name: input.as ?? imp.name, image: imageNames.get(imp.imageDigest) ?? '' };

      const created = await createRestoredImp(deps, point, base, imp, target, workDir);

      restored.push(created);

      const skipped = await createRestoredGrants(deps, target.name, imp);

      skippedGrants.push(...skipped);

      deps.log(
        `impd: backup: restored ${target.name} from ${point.id} (${point.time.toISOString()})`,
      );
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

// the newest point at or before `at` that holds `name`, or that names it
// as left out, when one is given
async function findPoint(
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

// the tokens and secrets of the backup's database copy, which stay when
// the imps' restore fails after them: a second restore of all skips them.
// It holds the copy's size while restic writes and impd reads it.
async function createRestoredDatabase(
  deps: RestoreDeps,
  point: ResticSnapshot,
  base: string,
  database: NonNullable<BackupManifest['database']>,
  workDir: string,
) {
  const file = requireTreeDatabase(database.file);
  const dir = join(workDir, dirname(file));

  const access = await deps.diskBudget.withRoom(database.sizeBytes, async () => {
    await deps.restic.restore(point.id, join(base, dirname(file)), dir, []);

    return createRestoredAccess(deps.db, deps.tokens, join(workDir, file));
  });

  deps.log(
    `impd: backup: restored ${String(access.tokens.length)} tokens and ${String(access.secrets.length)} secrets from ${point.id}`,
  );

  return access;
}

// The one path a run writes the copy at: a manifest that names another, as
// one altered could, would restore a file outside the restore's directory
function requireTreeDatabase(database: string): string {
  if (database !== BACKUP_TREE.database) {
    throw new Error(
      `the backup names its database copy at ${database}, not ${BACKUP_TREE.database}`,
    );
  }

  return database;
}

// An image with the same digest is reused; the name gets a digest suffix
// when another image has it. It joins the storage gate until its row
// commits, so a GC never takes the image in between.
function createRestoredImage(
  deps: RestoreDeps,
  point: ResticSnapshot,
  base: string,
  image: ManifestImage,
  workDir: string,
): Promise<string> {
  return deps.storageGate.join(() =>
    deps.diskBudget.withRoom(2 * image.sizeBytes, () =>
      createJoinedImage(deps, point, base, image, workDir),
    ),
  );
}

async function createJoinedImage(
  deps: RestoreDeps,
  point: ResticSnapshot,
  base: string,
  image: ManifestImage,
  workDir: string,
): Promise<string> {
  const existing = await findImageByDigest(deps.db, image.digest);

  if (existing !== undefined) {
    return existing.name;
  }

  // the name first: a clash on the fallback fails before any storage
  const name = await resolveRestoredImageName(deps, image);

  const dir = join(workDir, image.dir);

  await deps.restic.restore(point.id, join(base, image.dir), dir, []);

  await deps.storage.createImage(image.digest, async (target) => {
    writeFileSync(join(target, 'rootfs.ext4'), '');

    await writeChangedBlocks(join(dir, 'rootfs.ext4'), join(target, 'rootfs.ext4'));

    copyFileSync(join(dir, 'config.json'), join(target, 'config.json'));
  });

  rmSync(dir, { recursive: true, force: true });

  await createImage(deps.db, {
    name,
    ref: image.ref,
    digest: image.digest,
    sizeBytes: image.sizeBytes,
    source: image.source,
    sourceImp: image.sourceImp,
  });

  return name;
}

// its own name, else `<name>-<tag>` when another image has it
async function resolveRestoredImageName(deps: RestoreDeps, image: ManifestImage): Promise<string> {
  const taken = await findImageByName(deps.db, image.name);

  if (taken === undefined) {
    return image.name;
  }

  const fallback = `${image.name.slice(0, 22)}-${buildDigestTag(image.digest)}`;

  const fallbackTaken = await findImageByName(deps.db, fallback);

  if (fallbackTaken !== undefined) {
    throw buildConflictError(
      'image',
      fallback,
      `images ${image.name} and ${fallback} both exist; remove one to restore this image`,
    );
  }

  return fallback;
}

// the restored imp's name and the image it names
interface RestoreTarget {
  readonly name: string;
  readonly image: string;
}

interface RestoredSizes {
  readonly diskBytes: number;
  readonly usedBytes?: number | undefined;
}

// Each checkpoint is written over the disk in turn and snapshotted, oldest
// first, so the checkpoints share every block they did before.
async function createRestoredImp(
  deps: RestoreDeps,
  point: ResticSnapshot,
  base: string,
  imp: ManifestImp,
  target: RestoreTarget,
  workDir: string,
): Promise<Imp> {
  const created = { id: null as string | null };

  // One file at a time, each gone once written: ten checkpoints never sit
  // on the host as ten full disks at once. It holds twice the file's blocks
  // (restic's sparse copy, then the disk), or an older manifest's disk size.
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

    await deps.storage.createImpDisk(impId, { kind: 'empty' });

    const disk = deps.storage.resolveImpPaths(impId).disk;

    for (const checkpoint of imp.checkpoints) {
      await writeRestoredFile(checkpoint.disk, disk, checkpoint);

      const made = await createCheckpointDisk(deps, impId);

      await createCheckpoint(deps.db, {
        id: made.id,
        impId,
        label: checkpoint.label,
        sizeBytes: made.sizeBytes,
        createdAt: checkpoint.createdAt,
        diskBytes: checkpoint.diskBytes,
      });
    }

    await writeRestoredFile(imp.disk, disk, imp);
  };

  // a network the restore made goes again when the imp does not come back
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
      policy: resolveEgressPolicy(deps, target.name, imp),
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

const ID_ATTEMPTS = 3;

// ZFS can still hold a deleted checkpoint's id in a snapshot a fork needs
async function createCheckpointDisk(deps: RestoreDeps, impId: string) {
  for (let attempt = 1; ; attempt += 1) {
    const id = buildCheckpointId();

    try {
      const sizeBytes = await deps.storage.createCheckpoint(impId, id);

      return { id, sizeBytes };
    } catch (error) {
      if (!(error instanceof CheckpointIdTakenError) || attempt >= ID_ATTEMPTS) {
        throw error;
      }
    }
  }
}

// A policy this impd cannot read, from a newer backup, comes back as
// `none`, with a warning: never more open than it was.
function resolveEgressPolicy(deps: RestoreDeps, name: string, imp: ManifestImp): EgressPolicy {
  const parsed = EgressPolicySchema.safeParse({ mode: imp.egressPolicy, allow: imp.egressAllow });

  if (parsed.success) {
    return parsed.data;
  }

  deps.log(
    `impd: backup: ${name}: unknown egress policy ${JSON.stringify(imp.egressPolicy)}; restored as none`,
  );

  return { mode: 'none', allow: [] };
}

// only the imp this restore made: a name clash fails before any disk
async function removeFailedImp(
  deps: RestoreDeps,
  name: string,
  impId: string | null,
): Promise<void> {
  const found = await findImpByName(deps.db, name);

  if (impId === null || found?.id !== impId) {
    return;
  }

  await deps.imps.destroyImp(name).catch((error: unknown) => {
    deps.log(`impd: backup: ${name}: a failed restore left the imp: ${readErrorMessage(error)}`);
  });
}

// Grants by secret name: a value never leaves its host, so a grant comes
// back only where a secret of that name exists, and the rest are reported.
async function createRestoredGrants(deps: RestoreDeps, impName: string, imp: ManifestImp) {
  const skipped: SkippedGrant[] = [];

  const grants = [
    ...imp.grants.map((secret) => ({ secret, filter: undefined })),
    ...imp.filteredGrants,
  ];

  for (const grant of grants) {
    const secret = grant.secret;

    try {
      await deps.grants.addGrant(impName, secret, null, grant.filter);
    } catch (error) {
      skipped.push({ imp: impName, secret, reason: readErrorMessage(error) });
    }
  }

  return skipped;
}
