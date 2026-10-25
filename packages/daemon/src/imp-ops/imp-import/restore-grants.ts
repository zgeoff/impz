import type { GrantFilter } from '@impz/api';
import { getErrorMessage } from '../../platform/process/get-error-message';
import type { ImpGrants } from '../imp-grants';

interface ImportedGrants {
  readonly grants: readonly string[];
  readonly filteredGrants: readonly { readonly secret: string; readonly filter: GrantFilter }[];
}

export interface SkippedGrant {
  readonly secret: string;
  readonly reason: string;
}

export async function restoreGrants(
  deps: Readonly<{ grants: Pick<ImpGrants, 'addGrant'> }>,
  impName: string,
  imported: ImportedGrants,
): Promise<SkippedGrant[]> {
  const skipped: SkippedGrant[] = [];

  const grants = [
    ...imported.grants.map((secret) => ({ secret, filter: undefined })),
    ...imported.filteredGrants,
  ];

  for (const grant of grants) {
    try {
      await deps.grants.addGrant(impName, grant.secret, null, grant.filter);
    } catch (error) {
      skipped.push({ secret: grant.secret, reason: getErrorMessage(error) });
    }
  }

  return skipped;
}
