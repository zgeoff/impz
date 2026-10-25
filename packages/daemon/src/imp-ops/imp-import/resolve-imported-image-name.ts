import { readImageByName } from '../../platform/db/images';
import type { ImpDatabase } from '../../platform/db/open-database';
import { buildConflictError } from '../../platform/errors/impd-errors';
import { buildDigestTag } from './build-digest-tag';

export async function resolveImportedImageName(
  db: ImpDatabase,
  name: string,
  digest: string,
): Promise<string> {
  const taken = await readImageByName(db, name);

  if (taken === undefined) {
    return name;
  }

  const fallback = `${name.slice(0, 22)}-${buildDigestTag(digest)}`;

  const fallbackTaken = await readImageByName(db, fallback);

  if (fallbackTaken !== undefined) {
    throw buildConflictError(
      'image',
      fallback,
      `images ${name} and ${fallback} both exist; remove one to import this image`,
    );
  }

  return fallback;
}
