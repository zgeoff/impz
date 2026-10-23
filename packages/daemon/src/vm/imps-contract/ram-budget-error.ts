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

export class RamBudgetError extends ImpdError<'RAM_BUDGET_EXCEEDED'> {
  override name = 'RamBudgetError';

  readonly protectedImps: readonly ProtectedImp[];

  constructor(message: string, shortfall: Readonly<RamShortfall>) {
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
  }
}

export function buildImpOverBudgetError(budgetMib: number, usedMib: number, memoryMib: number) {
  return new RamBudgetError(
    `the imp's memory, at its max (${String(memoryMib)} MiB), is larger than the whole RAM budget (${String(budgetMib)} MiB)`,
    { budgetMib, usedMib, requestedMib: memoryMib, protected: [] },
  );
}

export function buildRamBudgetError(shortfall: Readonly<RamShortfall>) {
  const used = String(shortfall.usedMib);
  const budget = String(shortfall.budgetMib);
  const requested = String(shortfall.requestedMib);

  return new RamBudgetError(
    `not enough RAM: ${used} of ${budget} MiB in use, ${requested} MiB requested, and no idle imp left to sleep`,
    shortfall,
  );
}

export function buildNeededMib(usedMib: number, requestedMib: number, budgetMib: number): number {
  return Math.max(0, usedMib + requestedMib - budgetMib);
}

export function isRamBudgetError(error: unknown): boolean {
  return isImpdError(error, 'RAM_BUDGET_EXCEEDED');
}
