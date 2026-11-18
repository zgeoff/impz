import { PublicAuthSchema } from '@impz/api';
import type { ImpState } from '@impz/api';
import type { StoredPublicAuth } from './imps';
import type { ImpDatabase } from './open-database';

export interface PublicImp {
  readonly id: string;

  readonly state: ImpState;
  readonly stored: StoredPublicAuth;
}

export async function readPublicImp(db: ImpDatabase, name: string): Promise<PublicImp | undefined> {
  const row = await db
    .selectFrom('imps')
    .select(['id', 'state', 'exposure', 'public_auth', 'public_user', 'public_hash'])
    .where('name', '=', name)
    .executeTakeFirst();

  const auth = PublicAuthSchema.safeParse(row?.public_auth);

  // a value impd did not write is tailnet-only: closed, never open
  if (row?.exposure !== 'public' || !auth.success) {
    return undefined;
  }

  // token and basic auth without a hash would let anyone in
  if (auth.data !== 'none' && row.public_hash === null) {
    return undefined;
  }

  return {
    id: row.id,
    state: row.state,
    stored: { auth: auth.data, user: row.public_user, hash: row.public_hash },
  };
}

export async function listPublicImpNames(db: ImpDatabase): Promise<string[]> {
  const rows = await db
    .selectFrom('imps')
    .select('name')
    .where('exposure', '=', 'public')
    .orderBy('name')
    .execute();

  return rows.map((row) => row.name);
}
