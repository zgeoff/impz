import type { GrantID, OAuthClientID, StoredGrant } from '@zgeoff/mcp-auth';
import { toTagged } from '@zgeoff/std';
import type { ImpLimits } from '../../identity/oauth/imp-limits-schema';

export function buildMockStoredGrant(
  overrides: Partial<StoredGrant<ImpLimits>> = {},
): StoredGrant<ImpLimits> {
  return {
    grantID: toTagged<GrantID>('grant-1'),
    clientID: toTagged<OAuthClientID>('impc_conn'),
    scopes: ['read', 'exec'],
    approvedBy: 'passkey',
    limits: { imps: ['dev-*'], grantable: false },
    createdAt: 0,
    lastUsedAt: null,
    ...overrides,
  };
}
