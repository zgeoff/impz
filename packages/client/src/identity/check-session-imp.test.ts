import { expect, test } from 'bun:test';
import { checkSessionImp } from './check-session-imp';

function setupTest() {
  return { caller: { issuer: 'host-a', id: 'imp-1', name: 'dev-7f3a' } };
}

test('it allows a session that runs in the calling imp', () => {
  const ctx = setupTest();

  expect(
    checkSessionImp(ctx.caller, { impID: 'imp-1', impIssuer: 'host-a', impName: 'dev-7f3a' }),
  ).toStrictEqual({ kind: 'allowed' });
});

test('it refuses a call with no identity', () => {
  expect(
    checkSessionImp(null, { impID: 'imp-1', impIssuer: 'host-a', impName: 'dev-7f3a' }),
  ).toStrictEqual({ kind: 'refused', reason: 'no-identity' });
});

test('it refuses a session the host lists none of', () => {
  const ctx = setupTest();

  expect(checkSessionImp(ctx.caller, null)).toStrictEqual({
    kind: 'refused',
    reason: 'unknown-session',
  });
});

test('it refuses a session that runs in no imp', () => {
  const ctx = setupTest();

  expect(
    checkSessionImp(ctx.caller, { impID: null, impIssuer: null, impName: null }),
  ).toStrictEqual({ kind: 'refused', reason: 'not-in-an-imp' });
});

test('it refuses with imp-id-unknown until the host gives the id', () => {
  const ctx = setupTest();

  expect(
    checkSessionImp(ctx.caller, { impID: null, impIssuer: 'host-a', impName: 'dev-7f3a' }),
  ).toStrictEqual({ kind: 'refused', reason: 'imp-id-unknown' });
});

test('it refuses a record with no issuer with imp-issuer-unknown', () => {
  const ctx = setupTest();

  expect(
    checkSessionImp(ctx.caller, { impID: 'imp-1', impIssuer: null, impName: 'dev-7f3a' }),
  ).toStrictEqual({ kind: 'refused', reason: 'imp-issuer-unknown' });
});

test('it refuses the copy of an imp on another host with other-host, though the id matches', () => {
  expect(
    checkSessionImp(
      { issuer: 'host-b', id: 'imp-1', name: 'dev-7f3a' },
      { impID: 'imp-1', impIssuer: 'host-a', impName: 'dev-7f3a' },
    ),
  ).toStrictEqual({ kind: 'refused', reason: 'other-host' });
});

test('it refuses a session of another imp on the same host, though the name matches', () => {
  const ctx = setupTest();

  expect(
    checkSessionImp(ctx.caller, { impID: 'imp-2', impIssuer: 'host-a', impName: 'dev-7f3a' }),
  ).toStrictEqual({ kind: 'refused', reason: 'other-imp' });
});
