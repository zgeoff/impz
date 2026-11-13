import { expect, test } from 'bun:test';
import { buildMockCaller } from '../../test-utils/identity/build-mock-caller';
import { buildMockStoredGrant } from '../../test-utils/identity/build-mock-stored-grant';
import { pickGrantCheck } from './pick-grant-check';

test('#pickGrantCheck allows a grant the passkey approved its own scopes', () => {
  const grant = buildMockStoredGrant({ approvedBy: 'passkey', scopes: ['read', 'exec'] });

  expect(pickGrantCheck(grant, null)).toStrictEqual({ kind: 'allow', scopes: ['read', 'exec'] });
});

test.each([
  ['manage', ['read', 'exec']],
  ['exec', ['read', 'exec']],
] as const)(
  '#pickGrantCheck allows an exec grant of a %s token the scopes %p',
  (tokenScope, scopes) => {
    const grant = buildMockStoredGrant({ approvedBy: 'token:tok-1', scopes: ['read', 'exec'] });
    const approver = buildMockCaller({ scope: tokenScope, imps: ['dev-*'] });

    expect(pickGrantCheck(grant, approver)).toStrictEqual({ kind: 'allow', scopes });
  },
);

test.each([
  ['a removed token', null],
  ['a token that lost the scope', buildMockCaller({ scope: 'read', imps: null })],
  ['a token past whose imps it reaches', buildMockCaller({ scope: 'manage', imps: ['web-*'] })],
])('#pickGrantCheck revokes a grant approved by %s', (_what, approver) => {
  const grant = buildMockStoredGrant({
    approvedBy: 'token:tok-1',
    scopes: ['read', 'exec'],
    limits: { imps: ['dev-a'], grantable: false },
  });

  expect(pickGrantCheck(grant, approver)).toStrictEqual({
    kind: 'revoke',
    reason: 'the token that approved it no longer covers it',
  });
});

test('#pickGrantCheck revokes a grant over every imp whose token now has patterns', () => {
  const grant = buildMockStoredGrant({
    approvedBy: 'token:tok-1',
    scopes: ['read'],
    limits: { imps: null, grantable: false },
  });

  const approver = buildMockCaller({ scope: 'manage', imps: ['dev-*'] });

  expect(pickGrantCheck(grant, approver)).toMatchObject({ kind: 'revoke' });
});
