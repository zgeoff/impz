import type { Budgets } from './build-budgets';
import type { UsageTotals } from './build-usage-totals';
import { pickShortfall } from './pick-shortfall';
import type { Shortfall } from './pick-shortfall';

// An imp outside the priority patterns may not take the priority imps' unused RAM, so that RAM
// counts as in use for it; keptMib is the part of the shortfall's budget it counts.
export function pickEffectiveShortfall(
  usage: UsageTotals,
  budgets: Readonly<Budgets>,
  requestedMib: number,
  isPriority: boolean,
): Shortfall & { readonly keptMib: number } {
  const kept = isPriority ? { ramMib: 0, ordinaryMib: 0 } : usage.kept;

  const shortfall = pickShortfall(
    {
      ramMib: usage.effectiveMib + kept.ramMib,
      ordinaryMib: usage.ordinaryEffectiveMib + kept.ordinaryMib,
    },
    budgets,
    requestedMib,
  );

  const keptMib = shortfall.budget === 'ordinary' ? kept.ordinaryMib : kept.ramMib;

  return { ...shortfall, usedMib: shortfall.usedMib - keptMib, keptMib };
}
