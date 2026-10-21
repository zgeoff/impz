import { copyFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../../config';
import {
  countImageDigestUses,
  createImage,
  readImageById,
  readImageByName,
  updateImage,
  updateImageUse,
} from '../../platform/db/images';
import type { ImageRecord } from '../../platform/db/images';
import type { ImpDatabase } from '../../platform/db/open-database';
import { printLog } from '../../platform/process/print-log';
// oxlint-disable-next-line zgeoff/import-zones -- GEO-364 gives this layer its own errors
import {
  buildConflictError,
  buildInvalidStateError,
  buildNotBackedUpError,
} from '../../surface/api-errors';
import type { DiskFreezer } from '../../vm/checkpoints/consistent-disk';
import { createConsistentDisk } from '../../vm/checkpoints/consistent-disk';
import { buildImagePaths } from '../../vm/storage/data-layout';
import type { DiskBudget } from '../../vm/storage/disk-budget';
import type { StorageBackend } from '../../vm/storage/storage-backend';
import type { StorageGate } from '../../vm/storage/storage-gate';
import type { ImpCheckpointHooks } from '../imps/imp-service';
import { BUILDER_IMAGE } from './builder-imps';

// No Docker image ID starts with this prefix, so a template's digest never collides with one.
const TEMPLATE_DIGEST_PREFIX = 'imp-';

export interface TemplateService {
  readonly createTemplate: (impName: string, name: string) => Promise<ImageRecord>;
}

interface TemplateServiceDeps {
  readonly config: Config;
  readonly db: ImpDatabase;
  readonly imps: Pick<ImpCheckpointHooks, 'lockImp' | 'requireRunningImp'>;
  readonly storage: StorageBackend;

  readonly storageGate: StorageGate;

  readonly diskBudget: Pick<DiskBudget, 'requireRoom'>;
  readonly runImageEviction: () => Promise<void>;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
  readonly freezer?: DiskFreezer;
}

export function createTemplateService(deps: TemplateServiceDeps): TemplateService {
  const log = deps.log ?? printLog;
  const now = deps.now ?? Date.now;
  const storage = deps.storage;

  const withConsistentDisk = createConsistentDisk({
    storage,
    imps: deps.imps,
    log,
    freezer: deps.freezer,
  });

  const writeConfig = async (imageId: string, directory: string): Promise<void> => {
    const image = await readImageById(deps.db, imageId);

    const target = join(directory, 'config.json');

    const config =
      image === undefined ? undefined : buildImagePaths(deps.config.dataDir, image.digest).config;

    if (config !== undefined && existsSync(config)) {
      copyFileSync(config, target);
    } else {
      writeFileSync(target, '{}');
    }
  };

  const writeRow = (
    existing: ImageRecord | undefined,
    image: Readonly<{
      name: string;
      ref: string;
      digest: string;
      sizeBytes: number;
      sourceImp: string;
    }>,
  ): Promise<ImageRecord> => {
    if (existing === undefined) {
      return createImage(deps.db, { ...image, source: 'imp' }, now());
    }

    return updateImage(deps.db, existing.id, image, now());
  };

  const removeReplaced = async (existing: ImageRecord | undefined): Promise<void> => {
    if (existing !== undefined && (await countImageDigestUses(deps.db, existing.digest)) === 0) {
      await storage.removeImage(existing.digest);
    }
  };

  const writeTemplate = async (impName: string, name: string): Promise<ImageRecord> => {
    if (name === BUILDER_IMAGE) {
      throw buildConflictError(
        'image',
        name,
        `the image name ${name} is impd's, for its image builders; pick another`,
      );
    }

    await deps.diskBudget.requireRoom(0);

    // The storage gate is joined before the imp lock, in the order a backup run takes them.
    return deps.storageGate.join(() =>
      deps.imps.lockImp(impName, async (imp) => {
        if (imp.state === 'creating') {
          throw buildInvalidStateError(
            imp.state,
            ['running', 'sleeping', 'stopped', 'error'],
            'template',
          );
        }

        if (!imp.isBackedUp) {
          throw buildNotBackedUpError(
            imp.name,
            'a template of it would put its disk in every backup',
          );
        }

        // The use goes in before the read, so an image eviction keeps the template this
        // replaces until the new one lands.
        await updateImageUse(deps.db, 'name', [name], now());

        const existing = await readImageByName(deps.db, name);

        if (existing !== undefined && existing.source !== 'imp') {
          throw buildConflictError(
            'image',
            name,
            `image ${name} is a docker image; give the template a name of its own`,
          );
        }

        const started = performance.now();
        const digest = `${TEMPLATE_DIGEST_PREFIX}${Bun.randomUUIDv7()}`;

        await storage.createImageFromImp(digest, imp.id, {
          hold: (clone) => withConsistentDisk(imp, 'template', clone),
          write: (directory) => writeConfig(imp.imageId, directory),
        });

        const rootfs = buildImagePaths(deps.config.dataDir, digest).rootfs;

        const image = await writeRow(existing, {
          name,
          ref: `imp:${imp.name}`,
          digest,
          sourceImp: imp.name,
          sizeBytes: statSync(rootfs).blocks * 512,
        }).catch(async (error: unknown) => {
          await storage.removeImage(digest);

          throw error;
        });

        await removeReplaced(existing);

        const durationMs = Math.round(performance.now() - started);

        log(`impd: ${imp.name}: template ${name} in ${String(durationMs)}ms`);

        return image;
      }),
    );
  };

  return {
    createTemplate: async (impName, name) => {
      try {
        return await writeTemplate(impName, name);
      } finally {
        await deps.runImageEviction();
      }
    },
  };
}
