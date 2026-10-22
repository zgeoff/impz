import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NameSchema } from '@impz/api';
import type { ImageBuildPhase } from '@impz/api';
// oxlint-disable-next-line zgeoff/import-zones -- GEO-364 gives this layer its own errors
import { ORPCError } from '@orpc/server';
import * as z from 'zod';
import type { Config } from '../../config';
import {
  countImageDigestUses,
  createImage,
  readImageByName,
  updateImage,
  updateImageUse,
} from '../../platform/db/images';
import type { ImageRecord } from '../../platform/db/images';
import type { ImpDatabase } from '../../platform/db/open-database';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { buildKeyedMutex } from '../../platform/process/keyed-mutex';
import { runChecked, runCommand } from '../../platform/process/run-command';
import { createSingleFlight } from '../../platform/process/single-flight';
// oxlint-disable-next-line zgeoff/import-zones -- GEO-364 gives this layer its own errors
import { buildConflictError } from '../../surface/api-errors';
import { buildImagePaths, buildImagesDir } from '../../vm/storage/data-layout';
import type { DiskBudget } from '../../vm/storage/disk-budget';
import type { StorageBackend } from '../../vm/storage/storage-backend';
import type { StorageGate } from '../../vm/storage/storage-gate';
import { BUILDER_IMAGE } from './builder-imps';
import { writeGuestTree } from './guest-build';
import type { GuestExec } from './guest-exec';
import { buildImageRuntimeConfig } from './image-naming';
import { pickRepoDigest } from './image-pin';
import { planRootfs, planRootfsOverhead } from './rootfs-plan';
import { runDocker, runDockerChecked } from './run-docker';
import { writeExportedTree } from './unpack-export';
import { writeImageConfig } from './write-image-config';

const RepoDigestsSchema = z.array(z.string()).nullish();

const InspectSchema = z.tuple([
  z.object({
    Id: z.string(),
    Config: z.unknown(),
    Size: z.number().optional(),
    RepoDigests: RepoDigestsSchema,
  }),
]);

interface HostImageOptions {
  readonly onResolved?: ((reference: string) => void) | undefined;

  readonly signal?: AbortSignal | undefined;

  readonly onPulled?: (() => void) | undefined;
  readonly setPhase?: ((phase: ImageBuildPhase) => void) | undefined;
}

export interface ImageWriter {
  readonly createImageOnHost: (
    ref: string,
    imageName: string,
    options?: Readonly<HostImageOptions>,
  ) => Promise<ImageRecord>;

  readonly writeGuestImage: (
    exec: GuestExec,
    imageName: string,
    ref: string,
    signal: AbortSignal,
  ) => Promise<ImageRecord>;

  readonly removeIdleRootfs: (digest: string) => Promise<boolean>;

  readonly removeIdleImage: (digest: string, removeRow: () => Promise<boolean>) => Promise<boolean>;

  // A restore or a move publishes a rootfs and its row outside this writer.
  readonly withPublisher: <T>(
    digest: string,
    imageName: string,
    publish: () => Promise<T>,
  ) => Promise<T>;
}

interface ImageWriterDeps {
  readonly config: Config;
  readonly db: ImpDatabase;
  readonly storage: StorageBackend;

  readonly storageGate: StorageGate;

  readonly diskBudget: Pick<DiskBudget, 'withRoom' | 'withGrowingRoom'>;
  readonly log: (message: string) => void;

  readonly dockerEnv?: Readonly<Record<string, string>>;

  readonly now?: () => number;
}

interface GuestRootfs {
  readonly root: string;
  readonly digest: string;
  readonly config: unknown;
  readonly imageName: string;
  readonly ref: string;
  readonly signal: AbortSignal;
}

export function createImageWriter(deps: ImageWriterDeps): ImageWriter {
  const storageGate = deps.storageGate;
  const now = deps.now ?? Date.now;
  const building = createSingleFlight<number>();

  const publishers = new Map<string, number>();
  const freshRootfs = new Set<string>();

  const guestRootfsLock = buildKeyedMutex();
  const docker = { env: deps.dockerEnv };

  const readInspect = async (ref: string, signal: AbortSignal | undefined) => {
    const options = { ...docker, ...(signal !== undefined && { signal }) };

    const first = await runDocker(['image', 'inspect', ref], options);

    if (first.exitCode === 0) {
      return InspectSchema.parse(JSON.parse(first.stdout))[0];
    }

    await runDockerChecked(['pull', '--quiet', ref], options);

    signal?.throwIfAborted();

    const stdout = await runDockerChecked(['image', 'inspect', ref], options);

    return InspectSchema.parse(JSON.parse(stdout))[0];
  };

  // 0700 because the tree's setuid and capability files are live while it is unpacked, and no
  // host user may reach them.
  const makeWorkDir = (): { work: string; root: string } => {
    const images = buildImagesDir(deps.config.dataDir);
    const work = join(images, `.build-${Bun.randomUUIDv7()}`);
    const root = join(work, 'root');

    mkdirSync(images, { recursive: true });
    mkdirSync(work, { mode: 0o700 });
    mkdirSync(root, { mode: 0o755 });

    return { work, root };
  };

  const writeRootfs = async (root: string, digest: string, ociConfig: unknown): Promise<number> => {
    writeImageConfig(root, JSON.stringify(buildImageRuntimeConfig(ociConfig)));

    const usage = await readTreeUsage(root);

    const plan = planRootfs(usage);

    await deps.storage.createImage(digest, async (directory) => {
      const image = join(directory, 'rootfs.ext4');

      await runChecked(['truncate', '-s', String(plan.bytes), image]);

      // the default features keep resize_inode, which an online grow needs
      await runChecked([
        'mkfs.ext4',
        '-q',
        '-F',
        '-L',
        'imp-root',
        ...(plan.inodes === null ? [] : ['-N', String(plan.inodes)]),
        '-d',
        root,
        image,
      ]);

      writeFileSync(join(directory, 'config.json'), JSON.stringify(ociConfig ?? {}, null, 2));
    });

    return readDiskUsage(buildImagePaths(deps.config.dataDir, digest).rootfs);
  };

  const createRootfs = async (ref: string, digest: string, ociConfig: unknown): Promise<number> => {
    const paths = buildImagePaths(deps.config.dataDir, digest);

    if (existsSync(paths.rootfs)) {
      return readDiskUsage(paths.rootfs);
    }

    const created = await runDockerChecked(['create', ref, '/bin/true'], docker);

    const containerId = created.trim();

    try {
      const workDir = makeWorkDir();

      try {
        await writeExportedTree(containerId, workDir.root);

        return await writeRootfs(workDir.root, digest, ociConfig);
      } finally {
        rmSync(workDir.work, { recursive: true, force: true });
      }
    } finally {
      await runCommand(['docker', 'rm', '-f', containerId]);
    }
  };

  const createRootfsOnce = (digest: string, create: () => Promise<number>) =>
    building.run(digest, create);

  const writeImageRow = async (
    imageName: string,
    ref: string,
    digest: string,
    sizeBytes: number,
  ): Promise<ImageRecord> => {
    // The use goes in before the read, so an image eviction either sees it and keeps the row, or
    // removed the row first and the read finds nothing.
    const at = now();

    await updateImageUse(deps.db, 'name', [imageName], at);

    const existing = await readImageByName(deps.db, imageName);

    requireDockerImage(existing);

    if (existing === undefined) {
      return createImage(deps.db, { name: imageName, ref, digest, sizeBytes }, at);
    }

    if (existing.digest === digest) {
      return existing;
    }

    const updated = await updateImage(deps.db, existing.id, { ref, digest, sizeBytes }, at);

    await removeIdleRootfs(existing.digest);

    return updated;
  };

  const removeUnusedRootfs = async (digest: string): Promise<void> => {
    const uses = await countImageDigestUses(deps.db, digest);

    if (uses === 0) {
      await deps.storage.removeImage(digest);
    }
  };

  const removeIdleRootfs = (digest: string): Promise<boolean> =>
    guestRootfsLock.runExclusive(digest, async () => {
      if (publishers.has(digest)) {
        freshRootfs.add(digest);

        return false;
      }

      await removeUnusedRootfs(digest);

      return true;
    });

  const removeIdleImage = (digest: string, removeRow: () => Promise<boolean>): Promise<boolean> =>
    guestRootfsLock.runExclusive(digest, async () => {
      if (publishers.has(digest) || !(await removeRow())) {
        return false;
      }

      await removeUnusedRootfs(digest);

      return true;
    });

  const holdPublisher = (digest: string): Promise<void> =>
    guestRootfsLock.runExclusive(digest, () => {
      publishers.set(digest, (publishers.get(digest) ?? 0) + 1);

      return Promise.resolve();
    });

  const releasePublisher = (digest: string, imageName: string): Promise<void> =>
    guestRootfsLock.runExclusive(digest, async () => {
      const left = (publishers.get(digest) ?? 1) - 1;

      if (left > 0) {
        publishers.set(digest, left);

        return;
      }

      publishers.delete(digest);

      if (!freshRootfs.delete(digest)) {
        return;
      }

      try {
        await removeUnusedRootfs(digest);
      } catch (error) {
        deps.log(
          `impd: image ${imageName}: could not remove the unused rootfs of ${digest}: ${getErrorMessage(error)}`,
        );
      }
    });

  const createImageOnHost = async (
    ref: string,
    imageName: string,
    options: Readonly<HostImageOptions> = {},
  ): Promise<ImageRecord> => {
    const inspect = await readInspect(ref, options.signal);

    options.onPulled?.();
    const resolved = pickRepoDigest(ref, inspect.RepoDigests ?? []);

    if (resolved !== null) {
      options.onResolved?.(resolved);
    }

    options.setPhase?.('unpack');
    const treeBytes = inspect.Size ?? 0;
    const buildBytes = 2 * treeBytes + planRootfsOverhead(treeBytes);
    const withRoom = deps.diskBudget.withRoom;

    return withRoom(buildBytes, () =>
      storageGate.join(async () => {
        await holdPublisher(inspect.Id);

        try {
          const sizeBytes = await createRootfsOnce(inspect.Id, () =>
            createRootfs(ref, inspect.Id, inspect.Config),
          );

          return await writeImageRow(imageName, ref, inspect.Id, sizeBytes);
        } finally {
          await releasePublisher(inspect.Id, imageName);
        }
      }),
    );
  };

  const writeGuestRootfsAndRow = async (guest: Readonly<GuestRootfs>): Promise<ImageRecord> => {
    const digest = guest.digest;
    const rootfs = buildImagePaths(deps.config.dataDir, digest).rootfs;

    await holdPublisher(digest);

    try {
      guest.signal.throwIfAborted();

      const sizeBytes = await createRootfsOnce(digest, () => {
        if (existsSync(rootfs)) {
          return Promise.resolve(readDiskUsage(rootfs));
        }

        // A ZFS mount can fail after the rootfs is published, so the rootfs is marked before
        // the write and the cleanup still removes it.
        freshRootfs.add(digest);

        return writeRootfs(guest.root, digest, guest.config);
      });

      guest.signal.throwIfAborted();

      return await writeImageRow(guest.imageName, guest.ref, digest, sizeBytes);
    } finally {
      await releasePublisher(digest, guest.imageName);
    }
  };

  const writeGuestImage = (
    exec: GuestExec,
    imageName: string,
    ref: string,
    signal: AbortSignal,
  ): Promise<ImageRecord> => {
    const maxBytes = deps.config.build.imageMaxBytes;

    return deps.diskBudget.withGrowingRoom((grow) =>
      storageGate.join(async () => {
        const workDir = makeWorkDir();
        const root = workDir.root;

        try {
          const exported = await writeGuestTree(
            exec,
            root,
            { maxBytes, maxFiles: deps.config.build.imageMaxFiles },
            signal,
            grow,
          );

          return await writeGuestRootfsAndRow({
            root,
            digest: exported.digest,
            config: exported.config,
            imageName,
            ref,
            signal,
          });
        } finally {
          rmSync(workDir.work, { recursive: true, force: true });
        }
      }),
    );
  };

  const withPublisher = async <T>(
    digest: string,
    imageName: string,
    publish: () => Promise<T>,
  ): Promise<T> => {
    await holdPublisher(digest);

    try {
      return await publish();
    } finally {
      await releasePublisher(digest, imageName);
    }
  };

  return { createImageOnHost, writeGuestImage, removeIdleRootfs, removeIdleImage, withPublisher };
}

export function requireClientImageName(name: string): string {
  const imageName = NameSchema.parse(name);

  if (imageName === BUILDER_IMAGE) {
    throw new ORPCError('BAD_REQUEST', {
      message: `the image name ${BUILDER_IMAGE} is impd's, for its image builders; pick another`,
    });
  }

  return imageName;
}

export function requireDockerImage(existing: ImageRecord | undefined): void {
  if (existing?.source === 'imp') {
    throw buildConflictError(
      'image',
      existing.name,
      `image ${existing.name} is a template; make it again from an imp, or pick another name`,
    );
  }
}

async function readTreeUsage(root: string): Promise<{ bytes: number; inodes: number }> {
  const bytes = await runChecked(['du', '-s', '-B1', root]);
  const inodes = await runChecked(['du', '-s', '--inodes', root]);

  return { bytes: parseDuCount(bytes), inodes: parseDuCount(inodes) };
}

/* @internal */
export function parseDuCount(stdout: string): number {
  const count = Number(stdout.split(/\s/u)[0]);

  if (!Number.isSafeInteger(count)) {
    throw new TypeError(`du printed ${stdout}`);
  }

  return count;
}

function readDiskUsage(path: string): number {
  return statSync(path).blocks * 512;
}
