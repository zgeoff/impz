import type { Scope } from '@impz/api';
import type { MCPAuth } from '@zgeoff/mcp-auth';
import type { ImpLimits } from '../../identity/oauth/imp-limits-schema';
import type { ImpDatabase } from '../../platform/db/open-database';
import { seedOAuthGrant } from './seed-oauth-grant';

interface TokenOAuthGrantInput {
  readonly scope: Scope;
  readonly imps: readonly string[] | null;
  readonly tokenID: string;
}

// A grant an imp token approved before impd moved its grants to the shared OAuth server, as the
// move's migration leaves it: no sign-in makes one now, so the row is written here.
export async function seedTokenOAuthGrant(
  auth: MCPAuth<Scope, ImpLimits>,
  db: ImpDatabase,
  input: Readonly<TokenOAuthGrantInput>,
) {
  const grant = await seedOAuthGrant(auth, { scope: input.scope, imps: input.imps ?? ['*'] });

  await db
    .updateTable('user')
    .set({
      approvedBy: `token:${input.tokenID}`,
      limits: JSON.stringify({ imps: input.imps, grantable: false }),
    })
    .where('id', '=', grant.grantID)
    .execute();

  return grant;
}
