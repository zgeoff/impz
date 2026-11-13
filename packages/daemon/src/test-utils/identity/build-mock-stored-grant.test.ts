import { expect, test } from 'bun:test';
import type { GrantID, OAuthClientID } from '@zgeoff/mcp-auth';
import { toTagged } from '@zgeoff/std';
import { buildMockStoredGrant } from './build-mock-stored-grant';

test('it builds an exec grant the passkey approved on dev-*', () => {
  expect(buildMockStoredGrant()).toStrictEqual({
    grantID: toTagged<GrantID>('grant-1'),
    clientID: toTagged<OAuthClientID>('impc_conn'),
    scopes: ['read', 'exec'],
    approvedBy: 'passkey',
    limits: { imps: ['dev-*'], grantable: false },
    createdAt: 0,
    lastUsedAt: null,
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(buildMockStoredGrant({ approvedBy: 'token:tok-1', limits: null })).toMatchObject({
    approvedBy: 'token:tok-1',
    limits: null,
  });
});
