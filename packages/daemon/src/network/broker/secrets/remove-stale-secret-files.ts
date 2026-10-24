import type { ImpDatabase } from '../../../platform/db/open-database';
import { listFileRemovals, listValueFiles, removeFileRemoval } from '../../../platform/db/secrets';
import { getErrorMessage } from '../../../platform/process/get-error-message';
import { getImpdLogger } from '../../../platform/process/get-impd-logger';
import type { SecretFiles } from './secret-files';

export async function removeStaleSecretFiles(
  db: ImpDatabase,
  files: Pick<SecretFiles, 'remove' | 'keepOrphansExcept'>,
  at: Date,
): Promise<void> {
  const valueFiles = await listValueFiles(db);
  const pending = await removeRecordedFiles(db, files, valueFiles);

  // kept aside, not deleted: a value no row names may be a secret added after
  // the database copy that a restore put back
  const orphans = files.keepOrphansExcept(new Set([...valueFiles, ...pending]), at);

  for (const file of orphans.files) {
    getImpdLogger('broker').info(
      'kept secret value file {file}, which no database row names, in {directory}',
      { file, directory: orphans.directory ?? '' },
    );
  }
}

async function removeRecordedFiles(
  db: ImpDatabase,
  files: Pick<SecretFiles, 'remove'>,
  valueFiles: ReadonlySet<string>,
): Promise<string[]> {
  const recorded = await listFileRemovals(db);

  const failed: string[] = [];

  for (const file of recorded) {
    try {
      if (!valueFiles.has(file)) {
        files.remove(file);
      }

      await removeFileRemoval(db, file);
    } catch (error) {
      failed.push(file);

      getImpdLogger('broker').warning('could not remove an old secret value file: {error}', {
        error: getErrorMessage(error),
      });
    }
  }

  return failed;
}
