import type { LeaseRecord } from '../db/leases';
import { ImpdError } from './impd-error';

export class LeasedError extends ImpdError<'LEASED'> {
  override name = 'LeasedError';

  readonly impName: string;

  readonly leases: readonly LeaseRecord[];

  constructor(impName: string, leases: readonly LeaseRecord[]) {
    super('LEASED', {
      status: 409,
      message: `imp ${impName} has ${String(leases.length)} lease(s); force ends them`,
      data: { leases: [], otherCount: leases.length },
    });

    this.impName = impName;
    this.leases = leases;
  }
}
