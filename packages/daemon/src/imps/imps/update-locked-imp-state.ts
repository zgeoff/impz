import type { ImpRecord } from '../../platform/db/imps';
import type { ImpDatabase } from '../../platform/db/open-database';
import { updateImpState } from '../../platform/db/update-imp-state';
import type { ImpStateChange } from '../../platform/db/update-imp-state';
import { isLockedImp, toLockedImp } from './imp-lock';
import type { LockedImp } from './imp-lock';
import { requireTransition } from './imp-transitions';

export async function updateLockedImpState(
  db: ImpDatabase,
  imp: LockedImp,
  change: Readonly<ImpStateChange>,
): Promise<LockedImp> {
  const record: ImpRecord = imp;

  if (!isLockedImp(record)) {
    throw new Error(`imp ${record.id}: a state write needs the imp's lock`);
  }

  if (change.state !== imp.state) {
    requireTransition(imp.state, change.state, `move to ${change.state}`);
  }

  const updated = await updateImpState(db, imp.id, change);

  return toLockedImp(imp, updated);
}
