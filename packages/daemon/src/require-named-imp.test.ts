import { expect, test } from 'bun:test';
import { requireNamedImp } from './require-named-imp';
import { buildMockCaller } from './test-utils/build-mock-caller';

test.each([
  ['no imp named', ['dev-*'], 'read', undefined, 'read'],
  ['an imp its pattern covers', ['dev-*'], 'read', 'dev-a', 'read'],
  ['any imp for a host-wide caller', null, 'read', 'prod', 'read'],
  ['an exec on an imp it may run in', ['dev-*'], 'exec', 'dev-a', 'exec'],
] as const)('#requireNamedImp passes %s', (_kind, imps, scope, name, needed) => {
  const caller = buildMockCaller({ name: 'agent', imps, scope });

  expect(() => {
    requireNamedImp(caller, name, needed);
  }).not.toThrow();
});

test.each([
  ['an imp outside its pattern', ['dev-*'], 'read', 'prod', 'read'],
  ['a case variant of a covered name', ['dev-*'], 'read', 'DEV-a', 'read'],
  ['a covered name with whitespace', ['dev-a'], 'read', 'dev-a ', 'read'],
  ['an empty name', ['dev-*'], 'read', '', 'read'],
  ['an exec with a read scope', ['dev-*'], 'read', 'dev-a', 'exec'],
  ['a unicode look-alike of a covered name', ['dev-a'], 'read', 'd\u0435v-a', 'read'],
] as const)('#requireNamedImp refuses %s', (_kind, imps, scope, name, needed) => {
  const caller = buildMockCaller({ name: 'agent', imps, scope });

  expect(() => {
    requireNamedImp(caller, name, needed);
  }).toThrow(`may not touch imp ${name}`);
});
