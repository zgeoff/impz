import { hasScope } from '@impz/api';
import type { GrantCheck, StoredGrant } from '@zgeoff/mcp-auth';
import type { Caller } from '../../platform/principal/caller';
import { formatScopeList, isPatternsWithin, pickGrantScope, pickLowerScope } from './grant-limits';
import type { ImpLimits } from './imp-limits-schema';

// A grant an imp token approved, before impd moved its grants to the shared OAuth server, lasts
// only while that token still covers its scope and imps, and acts with no more than the token's
// scope. The owner's passkey approves every later grant.
export function pickGrantCheck(
  grant: StoredGrant<ImpLimits>,
  approver: Readonly<Caller> | null,
): GrantCheck {
  if (grant.approvedBy === 'passkey') {
    return { kind: 'allow', scopes: grant.scopes };
  }

  const scope = pickGrantScope(grant.scopes);
  const imps = grant.limits?.imps ?? null;

  if (approver === null || !hasScope(approver.scope, scope)) {
    return { kind: 'revoke', reason: 'the token that approved it no longer covers it' };
  }

  if (!isPatternsWithin(imps, approver.imps)) {
    return { kind: 'revoke', reason: 'the token that approved it no longer covers it' };
  }

  return {
    kind: 'allow',
    scopes: formatScopeList(pickLowerScope(scope, approver.scope)).split(' '),
  };
}
