import type { ImpRecord } from '../../platform/db/imps';
import type { ImpPaths } from '../../vm/storage/data-layout';
import type { SessionLogImp } from './session-log-service';

export function findSessionLogImp(
  findPaths: (impId: string) => ImpPaths,
  imp: Readonly<Pick<ImpRecord, 'id' | 'state'>>,
): SessionLogImp {
  const paths = findPaths(imp.id);

  return {
    id: imp.id,
    state: imp.state,
    vsockPath: paths.vsockSocket,
    sessionLogsDir: paths.sessionLogsDir,
  };
}
