import type { RamBudgetName } from '../../vm/imps-contract/ram-budget-error';
import type { Budgets } from './build-budgets';

export interface Shortfall {
  readonly budget: Exclude<RamBudgetName, 'pool'>;
  readonly budgetMib: number;
  readonly usedMib: number;
  readonly missingMib: number;
}

export function pickShortfall(
  used: Readonly<Record<'ramMib' | 'ordinaryMib', number>>,
  budgets: Readonly<Budgets>,
  requestedMib: number,
): Shortfall {
  const ram: Shortfall = {
    budget: 'ram',
    budgetMib: budgets.ramMib,
    usedMib: used.ramMib,
    missingMib: used.ramMib + requestedMib - budgets.ramMib,
  };

  if (budgets.ordinaryMib === null) {
    return ram;
  }

  const ordinaryMissingMib = used.ordinaryMib + requestedMib - budgets.ordinaryMib;

  return ordinaryMissingMib > ram.missingMib
    ? {
        budget: 'ordinary',
        budgetMib: budgets.ordinaryMib,
        usedMib: used.ordinaryMib,
        missingMib: ordinaryMissingMib,
      }
    : ram;
}
