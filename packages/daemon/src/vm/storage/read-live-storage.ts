import { listCheckpoints } from '../../platform/db/checkpoints';
import { listImages } from '../../platform/db/images';
import { listImps } from '../../platform/db/imps';
import type { ImpDatabase } from '../../platform/db/open-database';
import type { LiveStorage } from './storage-backend';

export async function readLiveStorage(db: ImpDatabase): Promise<LiveStorage> {
  const imps = await listImps(db);
  const images = await listImages(db);

  const checkpointIds = new Set<string>();

  for (const imp of imps) {
    for (const checkpoint of await listCheckpoints(db, imp.id)) {
      checkpointIds.add(checkpoint.id);
    }
  }

  return {
    impIds: new Set(imps.map((imp) => imp.id)),
    checkpointIds,
    imageDigests: new Set(images.map((image) => image.digest)),
  };
}
