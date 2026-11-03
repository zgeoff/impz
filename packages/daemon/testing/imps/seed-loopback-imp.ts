import invariant from 'tiny-invariant';
import type { Imps } from '../../src/imps/imps/imp-service';
import { readImpByName, updateImpAddress } from '../../src/platform/db/imps';
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

  await updateImpAddress(deps.db, imp.id, '127.0.0.1');

  const seeded = await readImpByName(deps.db, imp.name);

  invariant(seeded !== undefined);

  return seeded;
}
