import { readImpById } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import { getErrorMessage } from '../get-error-message';
import type { Imps } from '../imps/imp-service';

interface StagedImpDeps {
  readonly db: ImpDatabase;
  readonly imps: Pick<Imps, 'destroyImp'>;
  readonly log: (message: string) => void;
}

// only an imp a move staged here, never a live one of the same name
export async function removeStagedImp(
  deps: StagedImpDeps,
  name: string,
  impId: string,
): Promise<void> {
  const staged = await readImpById(deps.db, impId);

  if (staged?.moveState !== 'receiving') {
    return;
  }

  await deps.imps.destroyImp(name, { isMove: true }).catch((error: unknown) => {
    deps.log(`impd: move: ${name}: a failed receive left the imp: ${getErrorMessage(error)}`);
  });
}
