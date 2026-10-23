import { expect, mock, test } from 'bun:test';
import { Procedure, call } from '@orpc/server';
import { buildMockCaller } from '../../testing/identity/build-mock-caller';
import { createImplementer } from './create-implementer';

function setupTest() {
  const implementer = createImplementer({
    broker: { readSecretGeneration: () => Promise.resolve(null) },
    imps: { readImpRecord: () => Promise.resolve(undefined) },
    audit: { record: () => {} },
    now: () => 0,
  });

  return { implementer };
}

test('it runs a procedure whose metadata lets the caller in', () => {
  const ctx = setupTest();

  const handler = mock((): never => {
    throw new Error('the handler ran');
  });

  const procedure = ctx.implementer.system.info.handler(handler);

  expect(
    call(procedure, undefined, {
      context: { caller: buildMockCaller({ scope: 'manage', imps: null }), ends: null },
      path: ['system', 'info'],
    }),
  ).rejects.toThrow();

  expect(handler).toHaveBeenCalledOnce();
});

test('it refuses a procedure without access metadata at a path the contract rules, before its handler runs', () => {
  const ctx = setupTest();

  const handler = mock((): never => {
    throw new Error('the handler ran');
  });

  const implemented = ctx.implementer.system.info.handler(handler);

  const stripped = new Procedure({ ...implemented['~orpc'], meta: {} });

  expect(
    call(stripped, undefined, {
      context: { caller: buildMockCaller({ scope: 'manage', imps: null }), ends: null },
      path: ['system', 'info'],
    }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'this call has no access rule' });

  expect(handler).not.toHaveBeenCalled();
});
