import { getErrorMessage } from '../../../platform/process/get-error-message';
import type { ZfsCommands, ZfsEntry } from './zfs-commands';
import { planReclaimStep } from './zfs-reclaim';

interface ZfsReclaimContext {
  readonly zfs: ZfsCommands;
  readonly datasets: { readonly staging: string; readonly retired: string };
  readonly runSerial: <T>(task: () => Promise<T>) => Promise<T>;
  readonly listAll: () => Promise<ZfsEntry[]>;
  readonly log: (message: string) => void;
  readonly isKernelOopsed: () => boolean;
}

const MAX_RECLAIM_STEPS = 1000;

// zfs refuses a dataset a task still holds with `cannot destroy 'tank/imp/a': dataset is busy`.
const BUSY_DATASET = /'(?<name>[^']+)': dataset is busy/v;

export function createZfsReclaim(ctx: ZfsReclaimContext) {
  const oopsHeld = new Set<string>();

  const reclaim = { running: null as Promise<void> | null, isWanted: false };

  const runReclaimStep = async (): Promise<boolean> => {
    const entries = await ctx.listAll();

    const next = planReclaimStep(entries, ctx.datasets);

    if (next === null) {
      return true;
    }

    await (next.kind === 'promote' ? ctx.zfs.promote(next.name) : ctx.zfs.destroy(next.name));

    ctx.log(
      `impd: zfs: reclaim: ${next.kind === 'promote' ? 'promoted' : 'destroyed'} ${next.name}`,
    );

    return false;
  };

  const runReclaim = async (runStep: () => Promise<boolean>): Promise<void> => {
    try {
      for (let step = 0; step < MAX_RECLAIM_STEPS; step += 1) {
        const isDone = await runStep();

        if (isDone) {
          return;
        }
      }

      ctx.log(`impd: zfs: reclaim stopped after ${String(MAX_RECLAIM_STEPS)} steps`);
    } catch (error) {
      const message = getErrorMessage(error);
      const busy = BUSY_DATASET.exec(message)?.groups?.['name'];

      // A dataset that a kernel oops holds stays busy until the host reboots, so it is logged once.
      if (busy !== undefined && ctx.isKernelOopsed()) {
        if (!oopsHeld.has(busy)) {
          oopsHeld.add(busy);

          ctx.log(
            `impd: zfs: reclaim failed: ${message}; a kernel oops holds ${busy} until the host reboots, so impd logs it once`,
          );
        }

        return;
      }

      ctx.log(`impd: zfs: reclaim failed: ${message}`);
    }
  };

  const startReclaim = (): void => {
    reclaim.isWanted = true;

    if (reclaim.running !== null) {
      return;
    }

    const runPasses = async () => {
      while (reclaim.isWanted) {
        reclaim.isWanted = false;

        await runReclaim(() => ctx.runSerial(runReclaimStep));
      }

      reclaim.running = null;
    };

    reclaim.running = runPasses();
  };

  const waitForReclaim = async (): Promise<void> => {
    await reclaim.running;
  };

  return { runReclaimStep, runReclaim, startReclaim, waitForReclaim };
}
