import { listCheckpoints } from '../../platform/db/create-checkpoint';
import { listImages } from '../../platform/db/create-image';
import { listImps } from '../../platform/db/list-imps';
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
