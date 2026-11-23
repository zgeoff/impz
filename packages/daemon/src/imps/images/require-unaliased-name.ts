import type { ImpDatabase } from '../../platform/db/open-database';
import { probeImageAlias } from '../../platform/db/probe-image-alias';
import { buildConflictError } from '../../platform/errors/build-not-found-error';

export async function requireUnaliasedName(db: ImpDatabase, name: string): Promise<void> {
  const isAliased = await probeImageAlias(db, name);

  if (isAliased) {
    throw buildConflictError(
      'image',
      name,
      `image name ${name} is held by an alias; remove the alias first`,
    );
  }
}
