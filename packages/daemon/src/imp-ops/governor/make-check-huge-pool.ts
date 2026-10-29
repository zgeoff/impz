import type { AdmissionRequest } from '../../vm/imps-contract/ram-admission';
import { buildHugePoolError } from '../../vm/imps-contract/ram-budget-error';
import type { HugePagePool } from '../../vm/vmm/read-huge-page-pool';
import { buildHugePoolAdmission } from './build-huge-pool-admission';

interface PoolGuest {
  readonly id: string;
  readonly pid: number;
  readonly apiSocket: string;
  readonly hugePagesMib: number;
}

interface PoolRefusal {
  readonly name: string;
  readonly usedMib: number;
  readonly reserveMib: number;
  readonly neededMib: number;
}

interface CheckHugePoolDeps {
  readonly listAwake: () => Promise<readonly PoolGuest[]>;
  readonly readHugePool?: () => HugePagePool | null;
  readonly readHugetlbMib?: (pid: number, apiSocket: string) => Promise<number | null>;

  // admitted guests on 2 MiB pages that are not awake yet, by imp
  readonly pendingHugePages: Map<string, number>;
  readonly onRefused: (refusal: PoolRefusal) => void;
}

export function makeCheckHugePool(
  deps: CheckHugePoolDeps,
): (request: AdmissionRequest, hugePagesMib: number) => Promise<void> {
  const pendingHugePages = deps.pendingHugePages;

  return async (request, hugePagesMib) => {
    const listed = await deps.listAwake();

    const awake = listed.filter((imp) => imp.id !== request.id);

    for (const imp of awake) {
      pendingHugePages.delete(imp.id);
    }

    const onPages = awake.filter((imp) => imp.hugePagesMib > 0);

    const held = await Promise.all(
      onPages.map((imp) => deps.readHugetlbMib?.(imp.pid, imp.apiSocket) ?? Promise.resolve(0)),
    );

    // Guests fault pages in while the reads above run. Read after them, a fault
    // shows in the pool and the guest's count alike, or only in the pool: never
    // as free pool that the guest's count also leaves out.
    const pool = deps.readHugePool?.() ?? null;

    const poolAdmission = buildHugePoolAdmission({
      pool,
      awake: onPages.map((imp, index) => ({
        hugePagesMib: imp.hugePagesMib,
        heldMib: held[index] ?? 0,
      })),
      pendingMib: [...pendingHugePages].filter(([id]) => id !== request.id).map(([, mib]) => mib),
      requestedMib: hugePagesMib,
    });

    if (poolAdmission.admitted) {
      return;
    }

    if (request.name !== null) {
      deps.onRefused({
        name: request.name,
        usedMib: poolAdmission.committedMib,
        reserveMib: hugePagesMib,
        neededMib: poolAdmission.neededMib,
      });
    }

    throw buildHugePoolError({
      totalMib: poolAdmission.totalMib,
      committedMib: poolAdmission.committedMib,
      requestedMib: hugePagesMib,
    });
  };
}
