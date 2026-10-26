export interface UsageSample {
  readonly at: number;
  readonly usedMib: number;
}

export interface SleepSpan {
  readonly startAt: number;
  readonly endAt: number;

  readonly isEnforce: boolean;
}

export interface OvershootLimits {
  readonly budgetMib: number;

  // One enforce period plus one sample.
  readonly maxStartMs: number;

  readonly maxOverMib: number;
}

const MAX_SLEEP_MS = 30_000;

export type BudgetCheck = 'running' | 'final';

export function readMaxOpenMs(limits: OvershootLimits): number {
  return limits.maxStartMs + MAX_SLEEP_MS;
}

export interface Overshoot {
  readonly samples: readonly UsageSample[];
  readonly maxOverMib: number;

  readonly isOpen: boolean;
}

export interface BudgetBreach {
  readonly startAt: number;
  readonly maxOverMib: number;
  readonly why: string;
}

export function collectOvershoots(
  samples: readonly UsageSample[],
  budgetMib: number,
): readonly Overshoot[] {
  const overshoots: Overshoot[] = [];
  let run: UsageSample[] = [];

  for (const sample of samples) {
    if (sample.usedMib > budgetMib) {
      run.push(sample);
    } else if (run.length > 0) {
      overshoots.push(buildOvershoot(run, budgetMib, false));

      run = [];
    }
  }

  if (run.length > 0) {
    overshoots.push(buildOvershoot(run, budgetMib, true));
  }

  return overshoots;
}

function buildOvershoot(
  run: readonly UsageSample[],
  budgetMib: number,
  isOpen: boolean,
): Overshoot {
  return {
    samples: run,
    maxOverMib: Math.max(...run.map((sample) => sample.usedMib - budgetMib)),
    isOpen,
  };
}

export function collectBudgetBreaches(
  samples: readonly UsageSample[],
  sleeps: readonly SleepSpan[],
  limits: OvershootLimits,
  check: BudgetCheck = 'running',
): readonly BudgetBreach[] {
  return collectOvershoots(samples, limits.budgetMib).flatMap((overshoot) => {
    const why =
      check === 'final' && overshoot.isOpen
        ? 'still over the budget when the run ended'
        : checkOvershoot(overshoot, sleeps, limits);

    const [first] = overshoot.samples;

    return why === null || first === undefined
      ? []
      : [{ startAt: first.at, maxOverMib: overshoot.maxOverMib, why }];
  });
}

function checkOvershoot(
  overshoot: Overshoot,
  sleeps: readonly SleepSpan[],
  limits: OvershootLimits,
): string | null {
  if (overshoot.maxOverMib > limits.maxOverMib) {
    return `over by more than a guest grows past its reserve (${String(limits.maxOverMib)} MiB)`;
  }

  const [first] = overshoot.samples;
  const last = overshoot.samples.at(-1);

  if (first === undefined || last === undefined) {
    return null;
  }

  const deadline = first.at + limits.maxStartMs;

  if (last.at <= deadline) {
    return null;
  }

  const sleep = sleeps
    .filter((span) => span.isEnforce && span.endAt >= first.at && span.startAt <= deadline)
    .toSorted((left, right) => left.endAt - right.endAt)
    .at(0);

  if (sleep === undefined) {
    // A sleep under way has no event yet.
    const pending = overshoot.isOpen && last.at <= deadline + MAX_SLEEP_MS;

    return pending ? null : `no enforce sleep started within ${String(limits.maxStartMs)} ms`;
  }

  if (sleep.endAt - sleep.startAt > MAX_SLEEP_MS) {
    return `the enforce sleep took ${String(sleep.endAt - sleep.startAt)} ms`;
  }

  if (overshoot.samples.some((sample) => sample.at >= sleep.endAt)) {
    return `still over after the enforce sleep that ended ${String(sleep.endAt - first.at)} ms in`;
  }

  return null;
}
