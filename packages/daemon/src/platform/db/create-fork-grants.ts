import type { GrantNotCopied } from '@impz/api';
import type { ImpDatabase } from './open-database';
import { listGrants, readClash, readSecret, writeGrant } from './secrets';
import { readTokenGrantable } from './tokens';
import type { GrantableSecret } from './tokens';

export interface ForkAuthority {
  readonly tokenId: string | null;
  readonly grantable: readonly GrantableSecret[];
}

export type ForkGrantsOutcome =
  | { readonly kind: 'copied'; readonly notCopied: readonly GrantNotCopied[] }
  | { readonly kind: 'no-token' };

export function createForkGrants(
  db: ImpDatabase,
  fromImpId: string,
  toImpId: string,
  authority: Readonly<ForkAuthority> | null,
): Promise<ForkGrantsOutcome> {
  return db.transaction().execute(async (trx) => {
    const grants = await listGrants(trx, fromImpId);

    const current =
      authority === null || authority.grantable.length === 0 || authority.tokenId === null
        ? null
        : await readTokenGrantable(trx, authority.tokenId);

    if (authority !== null && authority.grantable.length > 0 && current === null) {
      return { kind: 'no-token' };
    }

    const notCopied: GrantNotCopied[] = [];

    for (const grant of grants) {
      const name = grant.secret;

      const secret = await readSecret(trx, name);

      // a tokens.update since the call began may have taken it off the list
      const entry = authority?.grantable.find(
        (each) =>
          each.name === name &&
          current?.some((now) => now.name === name && now.generation === each.generation) === true,
      );

      if (authority !== null && (entry === undefined || secret?.generation !== entry.generation)) {
        notCopied.push({ secret: name, reason: 'not-grantable' });
      } else if (secret === undefined) {
        notCopied.push({ secret: name, reason: 'no-secret' });
      } else if ((await readClash(trx, toImpId, name, secret.rules)) === null) {
        await writeGrant(trx, toImpId, secret, grant.filter ?? undefined);
      } else {
        notCopied.push({ secret: name, reason: 'clash' });
      }
    }

    return { kind: 'copied', notCopied };
  });
}
