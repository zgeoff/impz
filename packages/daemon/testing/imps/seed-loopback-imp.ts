import invariant from 'tiny-invariant';
import type { Imps } from '../../src/imps/imps/imp-service';
import { readImpByName } from '../../src/platform/db/imps';
import type { ImpRecord } from '../../src/platform/db/imps';
import type { ImpDatabase } from '../../src/platform/db/open-database';

interface LoopbackImpDeps {
  readonly db: ImpDatabase;
  readonly imps: Pick<Imps, 'createImp'>;
}

export async function seedLoopbackImp(
  deps: LoopbackImpDeps,
  input: Parameters<Imps['createImp']>[0],
): Promise<ImpRecord> {
  const imp = await deps.imps.createImp(input);

  // an imp whose guest answers on the host's loopback, so a test's server on 127.0.0.1 stands in
  // for the guest: impd gives each imp an address from its own subnet, never 127.0.0.1
  await deps.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();

  const seeded = await readImpByName(deps.db, imp.name);

  invariant(seeded !== undefined);

  return seeded;
}
