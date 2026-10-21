import type { ImpChangeReason } from '@impz/api';
import { listCheckpoints } from '../../platform/db/checkpoints';
import { listImps } from '../../platform/db/imps';
import type { ImpDatabase } from '../../platform/db/open-database';
import type { StartTimer } from '../../platform/process/clock';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { startRealTimer } from '../../platform/process/start-real-timer';
import type { ImpDiskUsage, StorageBackend } from './storage-backend';

const REFRESH_DELAY_MS = 10_000;

// a stop or a sleep changes disk use too, as the guest writes its cache and memory out
export const CHANGES_USAGE: ReadonlySet<ImpChangeReason> = new Set([
  'resized',
  'restored',
  'stopped',
  'slept',
]);

export interface CachedDiskUsage extends ImpDiskUsage {
  readonly measuredAt: Date;
  readonly isPartial: boolean;
}

export interface DiskUsageCache {
  readonly runPass: () => Promise<void>;
  readonly requestRefresh: () => void;
  readonly read: (impId: string) => CachedDiskUsage | undefined;
  readonly readExclusiveTotal: () => number;
  readonly stop: () => void;
}

interface DiskUsageCacheDeps {
  readonly db: ImpDatabase;
  readonly storage: Pick<StorageBackend, 'measureUsage'>;
  readonly log: (message: string) => void;
  readonly now?: () => Date;
  readonly refreshDelayMs?: number;
  readonly startTimer?: StartTimer;
}

// measuring usage on XFS runs FIEMAP over every file, too slow for a listing to wait on
export function createDiskUsageCache(deps: DiskUsageCacheDeps): DiskUsageCache {
  const now = deps.now ?? (() => new Date());
  const refreshDelayMs = deps.refreshDelayMs ?? REFRESH_DELAY_MS;
  const startTimer = deps.startTimer ?? startRealTimer;

  const state = {
    usage: new Map<string, CachedDiskUsage>(),
    running: null as Promise<void> | null,
    cancelRefresh: null as (() => void) | null,
    isStopped: false,
  };

  const readUsagePass = async (): Promise<void> => {
    const measuredAt = now();

    try {
      const imps = await listImps(deps.db);

      const listed = await Promise.all(
        imps.map(async (imp) => {
          const checkpoints = await listCheckpoints(deps.db, imp.id);

          return { impId: imp.id, checkpointIds: checkpoints.map((checkpoint) => checkpoint.id) };
        }),
      );

      const report = await deps.storage.measureUsage(listed);

      const kept = listed.flatMap((imp) => {
        const usage = report.imps.get(imp.impId);
        const last = state.usage.get(imp.impId);

        if (usage !== undefined) {
          return [[imp.impId, { ...usage, measuredAt, isPartial: report.isPartial }] as const];
        }

        return last === undefined ? [] : [[imp.impId, last] as const];
      });

      state.usage = new Map(kept);
    } catch (error) {
      deps.log(`impd: disk usage: ${getErrorMessage(error)}`);
    }
  };

  const runOnePass = async (): Promise<void> => {
    if (state.running !== null) {
      return state.running;
    }

    state.running = readUsagePass();

    try {
      await state.running;
    } finally {
      state.running = null;
    }
  };

  const runAfterCurrent = async (): Promise<void> => {
    await state.running;

    if (!state.isStopped) {
      await runOnePass();
    }
  };

  return {
    runPass: runOnePass,
    requestRefresh: () => {
      if (state.isStopped) {
        return;
      }

      state.cancelRefresh ??= startTimer(() => {
        state.cancelRefresh = null;
        void runAfterCurrent();
      }, refreshDelayMs);
    },
    read: (impId) => state.usage.get(impId),
    readExclusiveTotal: () =>
      [...state.usage.values()].reduce((total, usage) => total + usage.exclusiveBytes, 0),
    stop: () => {
      state.isStopped = true;

      if (state.cancelRefresh !== null) {
        state.cancelRefresh();

        state.cancelRefresh = null;
      }
    },
  };
}
