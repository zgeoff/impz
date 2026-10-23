import { buildBackupsOffError } from '../imp-ops/backup/backup-service';
import type { BackupService } from '../imp-ops/backup/backup-service';
import type { RpcImplementer } from './create-implementer';
import type { RouterDeps } from './create-router';

export function createBackupRoutes(os: RpcImplementer, deps: RouterDeps) {
  const requireBackups = (): BackupService => {
    if (deps.backups === null) {
      throw buildBackupsOffError();
    }

    return deps.backups;
  };

  return {
    run: os.backups.run.handler(() => requireBackups().runBackup()),
    list: os.backups.list.handler(() => requireBackups().readStatus()),
    restore: os.backups.restore.handler((context) => requireBackups().restoreBackup(context.input)),
    check: os.backups.check.handler(async (context) => {
      await requireBackups().checkBackups(context.input.subset);

      return {};
    }),
  };
}
