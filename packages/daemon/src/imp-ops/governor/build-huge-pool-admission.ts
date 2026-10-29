import type { HugePagePool } from '../../vm/vmm/read-huge-page-pool';

interface HugePageGuest {
  readonly hugePagesMib: number;
  readonly heldMib: number;
}

export interface HugePoolInput {
  readonly pool: HugePagePool | null;
  readonly awake: readonly HugePageGuest[];
  readonly pendingMib: readonly number[];
  readonly requestedMib: number;
}

export type HugePoolAdmission =
  | { readonly admitted: true }
  | {
      readonly admitted: false;
      readonly totalMib: number;
      readonly committedMib: number;
      readonly neededMib: number;
    };

// An awake guest may still take every block of its memory it has not touched,
// so the pool must hold those as well as the whole of the new guest.
export function buildHugePoolAdmission(input: HugePoolInput): HugePoolAdmission {
  const growthMib = input.awake.reduce(
    (sum, guest) => sum + Math.max(0, guest.hugePagesMib - guest.heldMib),
    0,
  );

  const pendingMib = input.pendingMib.reduce((sum, mib) => sum + mib, 0);
  const totalMib = input.pool?.totalMib ?? 0;
  const freeMib = input.pool?.freeMib ?? 0;
  const promisedMib = growthMib + pendingMib;

  if (promisedMib + input.requestedMib <= freeMib) {
    return { admitted: true };
  }

  return {
    admitted: false,
    totalMib,
    committedMib: totalMib - freeMib + promisedMib,
    neededMib: promisedMib + input.requestedMib - freeMib,
  };
}
