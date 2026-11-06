import type { PriorityRam } from '../../vm/vm-config';
import type { Budgets } from './build-budgets';
import type { UsageTotals } from './build-usage-totals';
import { pickShortfall } from './pick-shortfall';
import type { Shortfall } from './pick-shortfall';

// An imp outside the priority patterns may not take the priority imps' unused RAM, so that RAM
// counts as part of its request.
export function pickEffectiveShortfall(
  usage: UsageTotals,
  budgets: Readonly<Budgets>,
  requestedMib: number,
  kept: Readonly<PriorityRam> | null,
): Shortfall {
  return pickShortfall(
    { ramMib: usage.effectiveMib, ordinaryMib: usage.ordinaryEffectiveMib },
    budgets,
    requestedMib + (kept?.mib ?? 0),
  );
}
