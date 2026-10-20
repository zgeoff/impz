import { getErrorMessage } from '../../get-error-message';
import type { ZfsCommands, ZfsEntry } from './zfs-commands';
import { planReclaimStep } from './zfs-reclaim';

// what the ZFS backend lends its reclaim: its commands, its serial lane, the
// names of its datasets and its log
interface ZfsReclaimContext {
  readonly zfs: ZfsCommands;
  readonly datasets: { readonly staging: string; readonly retired: string };
  readonly runSerial: <T>(task: () => Promise<T>) => Promise<T>;
  readonly listAll: () => Promise<ZfsEntry[]>;
  readonly log: (message: string) => void;
  readonly isKernelOopsed: () => boolean;
}

// a reclaim pass ends after this many steps, so a bug never spins
const MAX_RECLAIM_STEPS = 1000;

// zfs's refusal of a dataset a task still holds, such as
// `cannot destroy 'tank/imp/a': dataset is busy`
const BUSY_DATASET = /'(?<name>[^']+)': dataset is busy/v;

// The ZFS backend's reclaim of retired datasets: one step at a time, and a
// pass in the background after each change that may free one
export function createZfsReclaim(ctx: ZfsReclaimContext) {
  // datasets an oops holds busy until a reboot, each logged once
  const oopsHeld = new Set<string>();

  const reclaim = { running: null as Promise<void> | null, isWanted: false };

  // one promote or destroy; true when nothing is left to reclaim
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

  // `runStep` queues each step on its own, so other changes go between them
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
      // the space comes back on the next pass; the change itself is done
      const message = getErrorMessage(error);
      const busy = BUSY_DATASET.exec(message)?.groups?.['name'];

      // no pass frees it before the reboot, so one line says so
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

  // after a change that may free a retired dataset; never awaited by it
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

  // resolves once the reclaim that changes start in the background is done
  const waitForReclaim = async (): Promise<void> => {
    await reclaim.running;
  };

  return { runReclaimStep, runReclaim, startReclaim, waitForReclaim };
}
