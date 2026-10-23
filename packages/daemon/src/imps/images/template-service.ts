import { copyFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readImageById } from '../../platform/db/images';
import type { ImageRecord } from '../../platform/db/images';
import type { ImpDatabase } from '../../platform/db/open-database';
import {
  buildConflictError,
  buildInvalidStateError,
  buildNotBackedUpError,
} from '../../platform/errors/impd-errors';
import { printLog } from '../../platform/process/print-log';
import type { DiskFreezer } from '../../vm/checkpoints/consistent-disk';
import { createConsistentDisk } from '../../vm/checkpoints/consistent-disk';
import { buildImagePaths } from '../../vm/storage/data-layout';
import type { DiskBudget } from '../../vm/storage/disk-budget';
import type { StorageBackend } from '../../vm/storage/storage-backend';
import type { StorageGate } from '../../vm/storage/storage-gate';
import type { ImpsConfig } from '../imps-config';
import type { ImpCheckpointHooks } from '../imps/imp-service';
import { readHeldImage } from './read-held-image';
import { requireClientImageName } from './require-client-image-name';
import { removeUnusedRootfs } from './rootfs/remove-unused-rootfs';
import { writeImageRow } from './write-image-row';

// No Docker image ID starts with this prefix, so a template's digest never collides with one.
const TEMPLATE_DIGEST_PREFIX = 'imp-';

export interface TemplateService {
  readonly createTemplate: (impName: string, name: string) => Promise<ImageRecord>;
}

interface TemplateServiceDeps {
  readonly config: ImpsConfig;
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

  const writeTemplate = async (impName: string, name: string): Promise<ImageRecord> => {
    requireClientImageName(name);

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

        const existing = await readHeldImage(deps.db, name, now());

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

        const image = await writeImageRow(
          deps.db,
          existing,
          {
            name,
            ref: `imp:${imp.name}`,
            digest,
            source: 'imp',
            sourceImp: imp.name,
            sizeBytes: statSync(rootfs).blocks * 512,
          },
          now(),
        ).catch(async (error: unknown) => {
          await storage.removeImage(digest);

          throw error;
        });

        if (existing !== undefined) {
          await removeUnusedRootfs(deps.db, storage, existing.digest);
        }

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
