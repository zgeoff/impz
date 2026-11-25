import type {
  SeedImpInput,
  SeedImps,
} from '@impz/testing/stand-in/build-imps-with-resolved-images';
import invariant from 'tiny-invariant';
import type { Imps } from '../../imps/imps/imp-service';
import { readImpByName, updateImpAddress } from '../../platform/db/list-imps';
import type { ImpRecord } from '../../platform/db/list-imps';
import type { ImpDatabase } from '../../platform/db/open-database';

interface LoopbackImpDeps {
  readonly db: ImpDatabase;
  readonly imps: Pick<SeedImps<Imps>, 'createImp'>;
}

export async function seedLoopbackImp(
  deps: LoopbackImpDeps,
  input: SeedImpInput,
): Promise<ImpRecord> {
  const imp = await deps.imps.createImp(input);

  await updateImpAddress(deps.db, imp.id, '127.0.0.1');

  const seeded = await readImpByName(deps.db, imp.name);

  invariant(seeded !== undefined);

  return seeded;
}
