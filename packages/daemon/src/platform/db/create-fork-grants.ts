import type { GrantNotCopied } from '@impz/api';
import type { ImpDatabase } from './open-database';
import { listGrants, readClash, readSecret, writeGrant } from './secrets';
import { readTokenGrantable } from './tokens';
import type { GrantableSecret } from './tokens';

// A fork's copy through a caller with imp patterns: only the secrets its
// grantable list names, at the generation the list holds, while its token
// exists (docs/guides/tokens.md#imp-patterns). Null for a host-wide caller.
export interface ForkAuthority {
  readonly tokenId: string | null;
  readonly grantable: readonly GrantableSecret[];
}

// what a fork's copy did: the source's grants it skipped, or that the
// caller's token was gone and it copied none
export type ForkGrantsOutcome =
  | { readonly kind: 'copied'; readonly notCopied: readonly GrantNotCopied[] }
  | { readonly kind: 'no-token' };

// A fork gets its source's grants, checked in one transaction: one the
// authority could not make, or one that clashes with a grant made on the
// fork since, is skipped (a null authority makes any).
export function createForkGrants(
  db: ImpDatabase,
  fromImpId: string,
  toImpId: string,
  authority: Readonly<ForkAuthority> | null,
): Promise<ForkGrantsOutcome> {
  return db.transaction().execute(async (trx) => {
    const grants = await listGrants(trx, fromImpId);

    // an empty list copies nothing whatever the token, so it needs no read
    // and never reports no-token: each grant is not-grantable instead
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

      // on the caller's list and on the token's now: a tokens.update since
      // the call began may have taken it off
      const entry = authority?.grantable.find(
        (each) =>
          each.name === name &&
          current?.some((now) => now.name === name && now.generation === each.generation) === true,
      );

      if (authority !== null && (entry === undefined || secret?.generation !== entry.generation)) {
        notCopied.push({ secret: name, reason: 'not-grantable' });
      } else if (secret === undefined) {
        // listGrants joins the live secret in this transaction, so none
        // is gone today; the reason stays in the contract all the same
        notCopied.push({ secret: name, reason: 'no-secret' });
      } else if ((await readClash(trx, toImpId, name, secret.rules)) === null) {
        // the fork's grant is as narrow as its source's
        await writeGrant(trx, toImpId, secret, grant.filter ?? undefined);
      } else {
        notCopied.push({ secret: name, reason: 'clash' });
      }
    }

    return { kind: 'copied', notCopied };
  });
}
