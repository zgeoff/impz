import { expect, test } from 'bun:test';
import { buildMockCaller } from '../../testing/identity/build-mock-caller';
import { findImpRefusal } from './find-imp-refusal';

test('it lets a caller with the scope through to an imp within its patterns', () => {
  const caller = buildMockCaller({ scope: 'exec', imps: ['dev-*'] });

  expect(findImpRefusal(caller, 'exec', 'dev-a', 'exec in')).toBeNull();
});

test('it refuses an imp outside the caller’s patterns, naming the action', () => {
  const caller = buildMockCaller({ name: 'laptop', scope: 'exec', imps: ['dev-*'] });
  const refusal = findImpRefusal(caller, 'exec', 'prod', 'exec in');

  expect(refusal).toMatchObject({
    code: 'FORBIDDEN',
    message: 'token laptop may not exec in imp prod',
  });
});

test('it refuses a caller whose scope is below what the action needs', () => {
  const caller = buildMockCaller({ name: 'reader', scope: 'read', imps: null });
  const refusal = findImpRefusal(caller, 'exec', 'dev-a', 'open a tunnel into');

  expect(refusal).toMatchObject({
    code: 'FORBIDDEN',
    message: 'token reader may not open a tunnel into imp dev-a',
  });
});

test('it refuses a socket that holds no caller as nobody', () => {
  const refusal = findImpRefusal(undefined, 'exec', 'dev-a', 'open a tunnel into');

  expect(refusal).toMatchObject({
    code: 'FORBIDDEN',
    message: 'nobody may not open a tunnel into imp dev-a',
  });
});
