import type { VmRam } from '../../vm/vmm/vm-stats';

interface MeasuredImp {
  readonly id: string;
  readonly hugePagesMib: number;
  readonly isPriority: boolean;
}

interface LiveReservation {
  readonly id: string;
  readonly mib: number;
  readonly isPriority: boolean;

  // the pool pages an admitted guest on 2 MiB pages may take, 0 for a guest on 4 KiB pages
  readonly poolMib: number;
}

interface UsageInput {
  readonly awake: readonly MeasuredImp[];
  readonly readings: readonly (VmRam | null)[];
  readonly reservations: readonly LiveReservation[];
  readonly lockedMib: number;
  readonly headroomMib: number;
  readonly priorityMib: number;
}

// the priority imps' RAM that they leave unused in each budget
interface KeptMib {
  readonly ramMib: number;
  readonly ordinaryMib: number;
  readonly poolMib: number;
}

export interface UsageTotals {
  readonly usedMib: number;
  readonly effectiveMib: number;

  // what the host and the guests hold outside the huge page pool
  readonly ordinaryUsedMib: number;
  readonly ordinaryEffectiveMib: number;
  readonly kept: KeptMib;
}

export function buildUsageTotals(
  input: Readonly<UsageInput>,
): UsageTotals & { readonly byImp: Map<string, number> } {
  const reserved = new Map(input.reservations.map((reservation) => [reservation.id, reservation]));
  const byImp = new Map<string, number>();

  let usedMib = input.lockedMib;
  let effectiveMib = input.lockedMib + input.headroomMib;
  let ordinaryUsedMib = input.lockedMib;
  let ordinaryEffectiveMib = input.lockedMib + input.headroomMib;
  const priority = { ramMib: 0, ordinaryMib: 0, poolMib: 0 };

  for (const [index, imp] of input.awake.entries()) {
    const reading = input.readings[index] ?? null;
    const measured = reading?.ramMib ?? 0;
    const effective = Math.max(measured, reserved.get(imp.id)?.mib ?? 0);

    // A guest on 2 MiB pages reserves its memory in the pool, so only what it holds beside its
    // pool pages counts outside the pool.
    const ordinary =
      imp.hugePagesMib > 0 ? Math.max(0, measured - (reading?.hugetlbMib ?? 0)) : effective;

    byImp.set(imp.id, effective);

    usedMib += measured;
    effectiveMib += effective;
    ordinaryUsedMib += imp.hugePagesMib > 0 ? ordinary : measured;
    ordinaryEffectiveMib += ordinary;

    if (imp.isPriority) {
      priority.ramMib += effective;
      priority.ordinaryMib += ordinary;
      priority.poolMib += imp.hugePagesMib;
    }
  }

  for (const reservation of input.reservations) {
    if (!byImp.has(reservation.id)) {
      const ordinary = reservation.poolMib > 0 ? 0 : reservation.mib;

      effectiveMib += reservation.mib;
      ordinaryEffectiveMib += ordinary;

      if (reservation.isPriority) {
        priority.ramMib += reservation.mib;
        priority.ordinaryMib += ordinary;
        priority.poolMib += reservation.poolMib;
      }
    }
  }

  return {
    byImp,
    usedMib,
    effectiveMib,
    ordinaryUsedMib,
    ordinaryEffectiveMib,
    kept: {
      ramMib: Math.max(0, input.priorityMib - priority.ramMib),
      ordinaryMib: Math.max(0, input.priorityMib - priority.ordinaryMib),
      poolMib: Math.max(0, input.priorityMib - priority.poolMib),
    },
  };
}
