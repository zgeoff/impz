import { ImpdError, isImpdError } from '../../platform/errors/impd-error';

export interface ProtectedImp {
  readonly name: string;
  readonly ramMib: number;
  readonly leased: boolean;
  readonly busy: boolean;
}

export interface RamShortfall {
  readonly budgetMib: number;
  readonly usedMib: number;
  readonly requestedMib: number;
  readonly protected: readonly ProtectedImp[];
}

// the whole budget, the part of it outside the host's huge page pool, or the pool
export type RamBudgetName = 'ram' | 'ordinary' | 'pool';

export class RamBudgetError extends ImpdError<'RAM_BUDGET_EXCEEDED'> {
  override name = 'RamBudgetError';

  readonly protectedImps: readonly ProtectedImp[];

  readonly budget: RamBudgetName;

  constructor(message: string, shortfall: Readonly<RamShortfall>, budget: RamBudgetName) {
    super('RAM_BUDGET_EXCEEDED', {
      status: 503,
      message,
      data: {
        budgetMib: shortfall.budgetMib,
        usedMib: shortfall.usedMib,
        requestedMib: shortfall.requestedMib,
        neededMib: buildNeededMib(shortfall.usedMib, shortfall.requestedMib, shortfall.budgetMib),
        protected: [],
        protectedHidden: shortfall.protected.length,
      },
    });

    this.protectedImps = shortfall.protected;
    this.budget = budget;
  }
}

const BUDGET_TITLES = {
  ram: 'the whole RAM budget',
  ordinary: 'the RAM budget outside the huge page pool',
} as const;

export function buildImpOverBudgetError(
  budget: Exclude<RamBudgetName, 'pool'>,
  shortfall: Readonly<Omit<RamShortfall, 'protected'>>,
) {
  return new RamBudgetError(
    `the imp's memory, at its max (${String(shortfall.requestedMib)} MiB), is larger than ${BUDGET_TITLES[budget]} (${String(shortfall.budgetMib)} MiB)`,
    { ...shortfall, protected: [] },
    budget,
  );
}

export function buildRamBudgetError(shortfall: Readonly<RamShortfall>) {
  const used = String(shortfall.usedMib);
  const budget = String(shortfall.budgetMib);
  const requested = String(shortfall.requestedMib);

  return new RamBudgetError(
    `not enough RAM: ${used} of ${budget} MiB in use, ${requested} MiB requested, and no idle imp left to sleep`,
    shortfall,
    'ram',
  );
}

export function buildOrdinaryBudgetError(shortfall: Readonly<RamShortfall>) {
  const used = String(shortfall.usedMib);
  const budget = String(shortfall.budgetMib);
  const requested = String(shortfall.requestedMib);

  return new RamBudgetError(
    `not enough RAM outside the huge page pool: ${used} of ${budget} MiB in use, ${requested} MiB requested on 4 KiB pages, and no idle imp left to sleep`,
    shortfall,
    'ordinary',
  );
}

interface HugePoolShortfall {
  readonly totalMib: number;

  // the pool pages in use, and those every admitted guest on 2 MiB pages may still take
  readonly committedMib: number;
  readonly requestedMib: number;
}

export function buildHugePoolError(shortfall: Readonly<HugePoolShortfall>) {
  const committed = String(shortfall.committedMib);
  const total = String(shortfall.totalMib);
  const requested = String(shortfall.requestedMib);

  return new RamBudgetError(
    `not enough 2 MiB pages: ${committed} of the host's ${total} MiB pool in use or promised to awake imps, ${requested} MiB requested`,
    {
      budgetMib: shortfall.totalMib,
      usedMib: shortfall.committedMib,
      requestedMib: shortfall.requestedMib,
      protected: [],
    },
    'pool',
  );
}

export function buildNeededMib(usedMib: number, requestedMib: number, budgetMib: number): number {
  return Math.max(0, usedMib + requestedMib - budgetMib);
}

export function isRamBudgetError(error: unknown): boolean {
  return isImpdError(error, 'RAM_BUDGET_EXCEEDED');
}

export function isOrdinaryBudgetError(error: unknown): boolean {
  return error instanceof RamBudgetError && error.budget === 'ordinary';
}
