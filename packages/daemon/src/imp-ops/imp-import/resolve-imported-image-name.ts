import { readImageByName } from '../../platform/db/create-image';
import type { ImpDatabase } from '../../platform/db/open-database';
import { probeImageAlias } from '../../platform/db/probe-image-alias';
import { buildConflictError } from '../../platform/errors/build-not-found-error';
import { buildDigestTag } from './build-digest-tag';

export async function resolveImportedImageName(
  db: ImpDatabase,
  name: string,
  digest: string,
): Promise<string> {
  const isTaken = await probeNameTaken(db, name);

  if (!isTaken) {
    return name;
  }

  const fallback = `${name.slice(0, 22)}-${buildDigestTag(digest)}`;

  const isFallbackTaken = await probeNameTaken(db, fallback);

  if (isFallbackTaken) {
    throw buildConflictError(
      'image',
      fallback,
      `images ${name} and ${fallback} both exist, or an alias holds one of them; remove one to import this image`,
    );
  }

  return fallback;
}

async function probeNameTaken(db: ImpDatabase, name: string): Promise<boolean> {
  const image = await readImageByName(db, name);

  if (image !== undefined) {
    return true;
  }

  return probeImageAlias(db, name);
}
