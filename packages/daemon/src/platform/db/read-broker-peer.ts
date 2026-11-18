import type { EgressPolicy } from '@impz/api';
import type { ImpDatabase } from './open-database';
import { parseStoredPolicy } from './read-egress-policy';

export interface BrokerPeer {
  readonly id: string;
  readonly name: string;
  readonly egress: EgressPolicy;
}

export async function readBrokerPeer(
  db: ImpDatabase,
  slot: number,
): Promise<BrokerPeer | undefined> {
  const row = await db
    .selectFrom('imps')
    .select(['id', 'name', 'egress_policy', 'egress_allow'])
    .where('slot', '=', slot)
    .executeTakeFirst();

  return row === undefined
    ? undefined
    : {
        id: row.id,
        name: row.name,
        egress: parseStoredPolicy(row.egress_policy, row.egress_allow),
      };
}
