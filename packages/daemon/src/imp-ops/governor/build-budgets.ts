import type { HugePagePool } from '../../vm/vmm/read-huge-page-pool';

export interface Budgets {
  readonly ramMib: number;

  // null on a host with no huge page pool
  readonly ordinaryMib: number | null;
}

// The host reserves the pool out of the RAM the budget counts, and a guest on 4 KiB pages never
// gets a pool page, so those guests share only the budget less the whole pool.
export function buildBudgets(budgetMib: number, pool: HugePagePool | null): Budgets {
  return {
    ramMib: budgetMib,
    ordinaryMib:
      pool === null || pool.totalMib === 0 ? null : Math.max(0, budgetMib - pool.totalMib),
  };
}
