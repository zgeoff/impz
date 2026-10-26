import type { WaitForOptions } from '@impz/test-utils/wait-for';
import { collectBudgetBreaches, readMaxOpenMs } from './budget-overshoot';
import type { BudgetCheck, Overshoot, OvershootLimits, SleepSpan } from './budget-overshoot';
import {
  FIRECRACKER_MEMORY_SCRIPT,
  parseFirecrackerMemory,
  readSmallestOwnedMib,
} from './firecracker-memory';
import { readInfo, requireImp } from './imp-cli';
import { runInContainer } from './instance';
import { startSleepWatch } from './sleep-events';
import type { SleepWatch } from './sleep-events';
import { waitFor } from './wait-for';

const BUDGET_SAMPLE_MS = 500;

export interface BudgetSample {
  // Taken before the reads, so an overshoot never looks shorter than it was.
  readonly at: number;
  readonly ramUsedMib: number;
  readonly awake: number;

  // Full PSS adds clean file pages that the governor leaves out, so it is
  // only reported, never checked against the budget.
  readonly firecrackerPssMib: number;
  readonly firecrackerOwnedMib: number;
}

export interface BudgetMonitor {
  readonly samples: readonly BudgetSample[];

  readonly sleeps: readonly SleepSpan[];

  readonly stop: () => Promise<void>;
}

export interface OvershootLimitsInput {
  readonly budgetMib: number;

  readonly memoryMib: number;

  readonly reservePercent: number;

  readonly enforceIntervalMs: number;
}

export function buildFillScript(fillMib: number): string {
  return (
    `mkdir -p /run/fill && mount -t tmpfs -o size=${String(fillMib + 16)}m tmpfs /run/fill && ` +
    `dd if=/dev/urandom of=/run/fill/blob bs=1M count=${String(fillMib)} 2>/dev/null`
  );
}

export function buildOvershootLimits(input: Readonly<OvershootLimitsInput>): OvershootLimits {
  return {
    budgetMib: input.budgetMib,
    maxStartMs: input.enforceIntervalMs + BUDGET_SAMPLE_MS,
    maxOverMib: Math.ceil((input.memoryMib * (100 - input.reservePercent)) / 100),
  };
}

export function collectBudgetViolations(
  samples: readonly BudgetSample[],
  sleeps: readonly SleepSpan[],
  limits: OvershootLimits,
  check: BudgetCheck,
): readonly string[] {
  const series = [
    ['ramUsedMib', samples.map((sample) => ({ at: sample.at, usedMib: sample.ramUsedMib }))],
    [
      'Firecracker owned',
      samples.map((sample) => ({ at: sample.at, usedMib: sample.firecrackerOwnedMib })),
    ],
  ] as const;

  return series.flatMap(([name, usage]) =>
    collectBudgetBreaches(usage, sleeps, limits, check).map(
      (breach) => `${name} ${String(breach.maxOverMib)} MiB over the budget: ${breach.why}`,
    ),
  );
}

export function readOvershootMs(overshoot: Overshoot): number {
  const [first] = overshoot.samples;
  const last = overshoot.samples.at(-1);

  return first === undefined || last === undefined ? 0 : last.at - first.at;
}

// A sample lost to a busy impd is no budget violation.
async function readBudgetSample(): Promise<BudgetSample | null> {
  const at = Date.now();

  const info = await readInfo().catch(() => null);

  if (info === null) {
    return null;
  }

  const smaps = await runInContainer(['sh', '-c', FIRECRACKER_MEMORY_SCRIPT]);

  const memory = parseFirecrackerMemory(smaps.stdout);

  return {
    at,
    ramUsedMib: info.ramUsedMib,
    awake: info.awakeCount,
    firecrackerPssMib: memory.pssMib,
    firecrackerOwnedMib: memory.ownedMib,
  };
}

export interface BudgetMonitorDeps {
  readonly readSample: () => Promise<BudgetSample | null>;
  readonly startWatch: () => Promise<SleepWatch>;

  readonly wait: (durationMs: number) => Promise<void>;
}

const MONITOR_DEPS: BudgetMonitorDeps = {
  readSample: readBudgetSample,
  startWatch: startSleepWatch,
  wait: (durationMs) => Bun.sleep(durationMs),
};

export async function startBudgetMonitor(
  deps: Readonly<BudgetMonitorDeps> = MONITOR_DEPS,
): Promise<BudgetMonitor> {
  const watch = await deps.startWatch();

  const samples: BudgetSample[] = [];

  const state = {
    isRunning: true,
    stopped: null as Promise<void> | null,

    // Kept for the stop to rethrow, so it is never an unhandled rejection.
    failure: null as Error | null,
  };

  const loop = (async () => {
    try {
      while (state.isRunning) {
        const sample = await deps.readSample();

        if (sample !== null) {
          samples.push(sample);
        }

        await deps.wait(BUDGET_SAMPLE_MS);
      }
    } catch (error) {
      state.failure = error instanceof Error ? error : new Error(String(error));
    }
  })();

  const stop = async () => {
    state.isRunning = false;

    await loop;

    await watch.stop();

    if (state.failure !== null) {
      throw state.failure;
    }
  };

  return {
    samples,
    sleeps: watch.sleeps,
    stop: () => {
      state.stopped ??= stop();

      return state.stopped;
    },
  };
}

export async function waitForSampleAfter(
  monitor: BudgetMonitor,
  since: number,
  afterMs: number,
  clock: Readonly<Pick<WaitForOptions, 'now' | 'wait'>> = {},
): Promise<void> {
  await waitFor(
    `a budget sample ${String(afterMs)} ms after ${String(since)}`,
    () => {
      const last = monitor.samples.at(-1);

      if (last === undefined || last.at < since + afterMs) {
        throw new Error(`last sample at ${String(last?.at)}`);
      }
    },
    clock,
  );
}

export async function waitForUnderBudget(
  monitor: BudgetMonitor,
  limits: OvershootLimits,
  clock: Readonly<Pick<WaitForOptions, 'now' | 'wait'>> = {},
): Promise<void> {
  await waitFor(
    'both budget figures under the budget',
    () => {
      const last = monitor.samples.at(-1);

      if (
        last === undefined ||
        last.ramUsedMib > limits.budgetMib ||
        last.firecrackerOwnedMib > limits.budgetMib
      ) {
        throw new Error(`last sample ${JSON.stringify(last)}`);
      }
    },
    { ...clock, timeoutMs: readMaxOpenMs(limits) },
  ).catch(() => {});
}

export async function readPerImpMib(names: readonly string[]): Promise<number> {
  const rows = await Promise.all(names.map((name) => requireImp(name)));
  const smaps = await runInContainer(['sh', '-c', FIRECRACKER_MEMORY_SCRIPT]);

  return readSmallestOwnedMib(
    rows.map((row) => row.id),
    parseFirecrackerMemory(smaps.stdout),
  );
}
