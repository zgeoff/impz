import { isImpAllowed } from '@impz/api';
import type { Imp } from '@impz/api';
import { toLeaseSummary } from '../identity/auth/caller-view';
import { readPresentedLeases } from '../imps/imps/imp-presenter';
import type { ImpService } from '../imps/imps/imp-service';
import type { Caller } from '../platform/principal/caller';

export interface CallerImps {
  readonly listCallerImps: (caller: Readonly<Caller>) => Promise<Imp[]>;
  readonly readCallerImps: (caller: Readonly<Caller>, imps: readonly Imp[]) => Promise<Imp[]>;
  readonly readCallerImp: (caller: Readonly<Caller>, imp: Imp | Promise<Imp>) => Promise<Imp>;
}

export function buildCallerImps(imps: Pick<ImpService, 'listImps' | 'readLeases'>): CallerImps {
  const listCallerImps = async (caller: Readonly<Caller>) => {
    const listed = await imps.listImps();

    return listed.filter((imp) => isImpAllowed(caller.imps, imp.name));
  };

  const readCallerImps = async (caller: Readonly<Caller>, shown: readonly Imp[]) => {
    const unread = shown.filter((imp) => readPresentedLeases(imp) === undefined);

    const byImp = await imps.readLeases(unread.map((imp) => imp.id));

    return shown.map((imp) => {
      const leases = readPresentedLeases(imp) ?? byImp.get(imp.id) ?? [];

      return { ...imp, leases: toLeaseSummary(caller, imp.name, leases) };
    });
  };

  const readCallerImp = async (caller: Readonly<Caller>, imp: Imp | Promise<Imp>) => {
    const [shown] = await readCallerImps(caller, [await imp]);

    if (shown === undefined) {
      throw new Error('an imp went missing on its way out');
    }

    return shown;
  };

  return { listCallerImps, readCallerImps, readCallerImp };
}
