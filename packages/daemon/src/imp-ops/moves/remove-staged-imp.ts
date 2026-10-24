import type { Imps } from '../../imps/imps/imp-service';
import { readImpById } from '../../platform/db/imps';
import type { ImpDatabase } from '../../platform/db/open-database';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { getImpdLogger } from '../../platform/process/get-impd-logger';

interface StagedImpDeps {
  readonly db: ImpDatabase;
  readonly imps: Pick<Imps, 'destroyImp'>;
}

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
    getImpdLogger('move')
      .with({ imp: name })
      .warning('a failed receive left the imp: {error}', { error: getErrorMessage(error) });
  });
}
