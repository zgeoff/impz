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

  // an admitted guest on 2 MiB pages, whose memory sits in the pool
  readonly isOnPool: boolean;
}

interface UsageInput {
  readonly awake: readonly MeasuredImp[];
  readonly readings: readonly (VmRam | null)[];
  readonly reservations: readonly LiveReservation[];
  readonly lockedMib: number;
  readonly headroomMib: number;
  readonly priorityMib: number;
}

export interface UsageTotals {
  readonly usedMib: number;
  readonly effectiveMib: number;

  // what the host and the guests hold outside the huge page pool
  readonly ordinaryUsedMib: number;
  readonly ordinaryEffectiveMib: number;

  // the priority imps' RAM that they leave unused
  readonly keptMib: number;
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
  let priorityUsedMib = 0;

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
    priorityUsedMib += imp.isPriority ? effective : 0;
  }

  for (const reservation of input.reservations) {
    if (!byImp.has(reservation.id)) {
      effectiveMib += reservation.mib;
      ordinaryEffectiveMib += reservation.isOnPool ? 0 : reservation.mib;
      priorityUsedMib += reservation.isPriority ? reservation.mib : 0;
    }
  }

  return {
    byImp,
    usedMib,
    effectiveMib,
    ordinaryUsedMib,
    ordinaryEffectiveMib,
    keptMib: Math.max(0, input.priorityMib - priorityUsedMib),
  };
}
