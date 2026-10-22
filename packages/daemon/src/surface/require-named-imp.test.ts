import { expect, test } from 'bun:test';
import type { Scope } from '@impz/api';
import { buildMockCaller } from '../../testing/identity/build-mock-caller';
import { requireNamedImp } from './require-named-imp';

interface RequireNamedImpRow {
  readonly kind: string;
  readonly imps: readonly string[] | null;
  readonly scope: Scope;
  readonly name: string | undefined;
  readonly needed: Scope;
}

test.each<RequireNamedImpRow>([
  { kind: 'no imp named', imps: ['dev-*'], scope: 'read', name: undefined, needed: 'read' },
  {
    kind: 'an imp its pattern covers',
    imps: ['dev-*'],
    scope: 'read',
    name: 'dev-a',
    needed: 'read',
  },
  {
    kind: 'any imp for a host-wide caller',
    imps: null,
    scope: 'read',
    name: 'prod',
    needed: 'read',
  },
  {
    kind: 'an exec on an imp it may run in',
    imps: ['dev-*'],
    scope: 'exec',
    name: 'dev-a',
    needed: 'exec',
  },
])('#requireNamedImp passes $kind', (row) => {
  const caller = buildMockCaller({ name: 'agent', imps: row.imps, scope: row.scope });

  expect(() => {
    requireNamedImp(caller, row.name, row.needed);
  }).not.toThrow();
});

test.each<RequireNamedImpRow>([
  {
    kind: 'an imp outside its pattern',
    imps: ['dev-*'],
    scope: 'read',
    name: 'prod',
    needed: 'read',
  },
  {
    kind: 'a case variant of a covered name',
    imps: ['dev-*'],
    scope: 'read',
    name: 'DEV-a',
    needed: 'read',
  },
  {
    kind: 'a covered name with whitespace',
    imps: ['dev-a'],
    scope: 'read',
    name: 'dev-a ',
    needed: 'read',
  },
  { kind: 'an empty name', imps: ['dev-*'], scope: 'read', name: '', needed: 'read' },
  {
    kind: 'an exec with a read scope',
    imps: ['dev-*'],
    scope: 'read',
    name: 'dev-a',
    needed: 'exec',
  },
  {
    kind: 'a unicode look-alike of a covered name',
    imps: ['dev-a'],
    scope: 'read',
    name: 'd\u0435v-a',
    needed: 'read',
  },
])('#requireNamedImp refuses $kind', (row) => {
  const caller = buildMockCaller({ name: 'agent', imps: row.imps, scope: row.scope });

  expect(() => {
    requireNamedImp(caller, row.name, row.needed);
  }).toThrow(`may not touch imp ${String(row.name)}`);
});
