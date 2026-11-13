import type { Scope } from '@impz/api';
import type { Access } from '@zgeoff/mcp-auth';
import type { Caller } from '../../platform/principal/caller';
import { pickGrantScope } from './grant-limits';
import type { ImpLimits } from './imp-limits-schema';

type OAuthAccess = Extract<Access<Scope, ImpLimits>, { kind: 'oauth' }>;

// approver: the imp token that approved the grant, for a grant from before impd moved its grants
// to the shared OAuth server; null for a grant the owner's passkey approved.
export function buildOAuthCaller(
  access: Readonly<OAuthAccess>,
  approver: Readonly<Caller> | null,
): Caller | null {
  // With no scope left, the lowest scope would still read every imp the grant names; with no
  // limits, a null imps would reach every imp.
  if (access.scopes.length === 0 || access.limits === null) {
    return null;
  }

  const shared = {
    kind: 'oauth',
    name: `${access.clientName}/${access.grantID}`,
    scope: pickGrantScope(access.scopes),
    imps: access.limits.imps,
    imageRefPrefix: null,
    grantId: access.grantID,
    principal: `grant:${access.grantID}`,
  } as const;

  if (approver === null) {
    return {
      ...shared,
      grantable: [],
      tokenId: null,
      expiresAt: null,
      display: `${access.clientName} via passkey`,
    };
  }

  return {
    ...shared,
    grantable: approver.grantable,
    tokenId: approver.tokenId,
    expiresAt: approver.expiresAt,
    display: `${access.clientName} via ${approver.display}`,
  };
}
