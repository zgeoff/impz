import { countImageDigestUses } from '../../../platform/db/images';
import type { ImpDatabase } from '../../../platform/db/open-database';
import type { StorageBackend } from '../../../vm/storage/storage-backend';

export async function removeUnusedRootfs(
  db: ImpDatabase,
  storage: Pick<StorageBackend, 'removeImage'>,
  digest: string,
): Promise<void> {
  if ((await countImageDigestUses(db, digest)) === 0) {
    await storage.removeImage(digest);
  }
}
