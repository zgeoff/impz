import { expect, test } from 'bun:test';
import type { Scope } from '@impz/api';
import type { GrantID, OAuthClientID } from '@zgeoff/mcp-auth';
import { toTagged } from '@zgeoff/std';
import { buildMockCaller } from '../../test-utils/identity/build-mock-caller';
import { buildOAuthCaller } from './build-oauth-caller';
import type { ImpLimits } from './imp-limits-schema';

test('#buildOAuthCaller builds the caller of a grant the passkey approved', () => {
  const access: Parameters<typeof buildOAuthCaller>[0] = {
    kind: 'oauth',
    grantID: toTagged<GrantID>('grant-1'),
    clientID: toTagged<OAuthClientID>('impc_conn'),
    clientName: 'conn',
    scopes: ['read', 'exec'],
    limits: { imps: ['dev-*'], grantable: false },
  };

  expect(buildOAuthCaller(access, null)).toStrictEqual({
    kind: 'oauth',
    name: 'conn/grant-1',
    scope: 'exec',
    imps: ['dev-*'],
    grantable: [],
    imageRefPrefix: null,
    tokenId: null,
    grantId: 'grant-1',
    expiresAt: null,
    principal: 'grant:grant-1',
    display: 'conn via passkey',
  });
});

test('#buildOAuthCaller builds the caller of a grant an imp token approved, with its secrets', () => {
  const access: Parameters<typeof buildOAuthCaller>[0] = {
    kind: 'oauth',
    grantID: toTagged<GrantID>('grant-1'),
    clientID: toTagged<OAuthClientID>('impc_conn'),
    clientName: 'conn',
    scopes: ['read'],
    limits: { imps: null, grantable: true },
  };

  const approver = buildMockCaller({
    tokenId: 'tok-1',
    display: 'laptop',
    grantable: [{ name: 'gh', generation: 'gen-1' }],
  });

  expect(buildOAuthCaller(access, approver)).toMatchObject({
    scope: 'read',
    imps: null,
    grantable: [{ name: 'gh', generation: 'gen-1' }],
    tokenId: 'tok-1',
    display: 'conn via laptop',
  });
});

test.each<[string, readonly Scope[], ImpLimits | null]>([
  ['no scope', [], { imps: ['dev-*'], grantable: false }],
  ['no limits', ['read'], null],
])('#buildOAuthCaller builds no caller for a grant with %s', (_what, scopes, limits) => {
  const access: Parameters<typeof buildOAuthCaller>[0] = {
    kind: 'oauth',
    grantID: toTagged<GrantID>('grant-1'),
    clientID: toTagged<OAuthClientID>('impc_conn'),
    clientName: 'conn',
    scopes,
    limits,
  };

  expect(buildOAuthCaller(access, null)).toBeNull();
});
