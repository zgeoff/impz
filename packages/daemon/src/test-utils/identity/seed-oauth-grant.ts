import type { Scope } from '@impz/api';
import type { MCPAuth } from '@zgeoff/mcp-auth';
import { authorizeTestClient } from '@zgeoff/mcp-auth/testing';
import { formatScopeList } from '../../identity/oauth/grant-limits';
import type { ImpLimits } from '../../identity/oauth/imp-limits-schema';

interface OAuthGrantInput {
  readonly scope: Scope;
  readonly imps: readonly string[];
}

// A new client signs in, and the owner's passkey approves the scope and the imp patterns on the
// consent page.
export function seedOAuthGrant(auth: MCPAuth<Scope, ImpLimits>, input: Readonly<OAuthGrantInput>) {
  return authorizeTestClient(auth, {
    scopes: formatScopeList(input.scope).split(' '),
    consentFields: new URLSearchParams({ imps: input.imps.join(' ') }),
  });
}
