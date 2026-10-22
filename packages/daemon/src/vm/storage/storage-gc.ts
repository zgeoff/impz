import type { DroppedStorage, OrphanStorage, StorageGc } from '@impz/api';
// oxlint-disable-next-line zgeoff/import-zones -- GEO-372 puts the broker behind a port
import type { SecretFiles } from '../../network/broker/secret-files';
import type { ImpDatabase } from '../../platform/db/open-database';
import { ImpdError } from '../../platform/errors/impd-error';
import { printSweep } from './print-sweep';
import type { OrphanLogging } from './print-sweep';
import { readLiveStorage } from './read-live-storage';
import type { StorageBackend } from './storage-backend';
import type { StorageGate } from './storage-gate';

const MANUAL_WAIT_MS = 30_000;
const SCHEDULED_WAIT_MS = 600_000;

interface StorageGcDeps {
  readonly db: ImpDatabase;
  readonly storage: Pick<StorageBackend, 'dropUnnamed'>;
  readonly storageGate: StorageGate;
  readonly log: (message: string) => void;
  readonly secretFiles?: Pick<SecretFiles, 'listKept' | 'removeKept'>;
  readonly manualWaitMs?: number;
  readonly scheduledWaitMs?: number;
}

interface GcOptions {
  readonly isDryRun: boolean;
  readonly isOrphans: boolean;
}

interface ManualGcOptions extends GcOptions {
  readonly isSecretFiles?: boolean;
  readonly isRemoveSecretFiles?: boolean;
}

export interface StorageGcService {
  readonly runGc: (options: ManualGcOptions) => Promise<StorageGc>;
  readonly runScheduled: () => Promise<void>;
}

export function createStorageGc(deps: StorageGcDeps): StorageGcService {
  const hourly = { lastKept: null as string | null };

  const runAlone = async (options: GcOptions, waitMs: number, isScheduled: boolean) => {
    const result = await deps.storageGate.runAlone(async () => {
      const live = await readLiveStorage(deps.db);

      return deps.storage.dropUnnamed(live, options);
    }, waitMs);

    if (result.ran && !options.isDryRun) {
      const kept = JSON.stringify(result.value.kept.map((orphan) => orphan.location));
      const isChanged = kept !== hourly.lastKept;
      const scheduledLogging: OrphanLogging = isChanged ? 'each' : 'count';
      const logging = isScheduled ? scheduledLogging : 'none';

      if (isScheduled) {
        hourly.lastKept = kept;
      }

      printSweep(deps.log, 'impd: gc', result.value, logging);
    }

    return result;
  };

  return {
    runGc: async (options) => {
      const result = await runAlone(options, deps.manualWaitMs ?? MANUAL_WAIT_MS, false);

      if (!result.ran) {
        throw new ImpdError('PRECONDITION_FAILED', {
          message: `storage is busy (${String(deps.storageGate.countInFlight())} operations in flight, a backup run among them perhaps); try again`,
        });
      }

      const isAsked = options.isSecretFiles === true || options.isRemoveSecretFiles === true;
      const secrets = isAsked ? removeSecretFiles(deps, options) : null;

      return {
        dryRun: options.isDryRun,
        dropped: [...result.value.dropped, ...(secrets?.dropped ?? [])],
        kept: [...result.value.kept, ...(secrets?.kept ?? [])],
      };
    },
    runScheduled: async () => {
      const result = await runAlone(
        { isDryRun: false, isOrphans: false },
        deps.scheduledWaitMs ?? SCHEDULED_WAIT_MS,
        true,
      );

      if (!result.ran) {
        deps.log('impd: gc: storage stayed busy; the next pass tries again');
      }
    },
  };
}

function removeSecretFiles(
  deps: Readonly<StorageGcDeps>,
  options: Readonly<ManualGcOptions>,
): { readonly dropped: DroppedStorage[]; readonly kept: OrphanStorage[] } {
  const kept = deps.secretFiles?.listKept() ?? [];

  if (!options.isOrphans || options.isRemoveSecretFiles !== true) {
    return {
      dropped: [],
      kept: kept.map((entry) => ({
        kind: 'secrets',
        id: entry.name,
        location: entry.path,
        bytes: entry.bytes,
        createdAt: entry.createdAt,
        snapshots: [],
        files: entry.files,
      })),
    };
  }

  if (!options.isDryRun) {
    for (const entry of kept) {
      deps.secretFiles?.removeKept(entry.name);
      deps.log(`impd: gc: removed kept secret values ${entry.path}`);
    }
  }

  return { dropped: kept.map((entry) => ({ kind: 'secrets', id: entry.name })), kept: [] };
}
