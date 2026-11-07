import type { ImpChangeReason, ImpEventDetail } from '@impz/api';
import { appendImpEvent } from './append-imp-event';
import type { ImpRecord } from './imps';
import type { ImpQueries } from './open-database';

interface ImpChange {
  readonly reason: ImpChangeReason;
  readonly detail?: ImpEventDetail | undefined;
}

// Run it in the transaction that changed the imp's row.
export async function appendImpChange(
  db: ImpQueries,
  imp: ImpRecord,
  change: ImpChange,
): Promise<ImpRecord> {
  await appendImpEvent(
    db,
    {
      ev: 'ImpChanged',
      imp,
      reason: change.reason,
      ...(change.detail !== undefined && { detail: change.detail }),
    },
    Date.now(),
  );

  return imp;
}
