import { expect, test } from 'bun:test';
import * as z from 'zod';
import { ACCESS } from './access';
import { collectProcedureAccess } from './collect-procedure-access';
import { contractBase } from './contract-base';
import { impContract } from './imp-contract';
import { sessionContract } from './session-contract';

test('it finds an access rule on every procedure of the contract', () => {
  const entries = collectProcedureAccess(impContract);

  expect(entries.filter((entry) => entry.access === null)).toStrictEqual([]);
});

test('it reports a procedure with no access metadata as having no rule', () => {
  const contract = {
    notes: {
      list: contractBase.meta(ACCESS.readAny).output(z.array(z.string())),
      archive: contractBase.input(z.object({ name: z.string() })).output(z.string()),
    },
  };

  expect(collectProcedureAccess(contract)).toStrictEqual([
    { path: 'notes.list', access: { scope: 'read', on: 'any' } },
    { path: 'notes.archive', access: null },
  ]);
});

test('it reads the login and logout as needing no session', () => {
  expect(collectProcedureAccess(sessionContract)).toStrictEqual([
    { path: 'auth.login', access: { on: 'none' } },
    { path: 'auth.logout', access: { on: 'none' } },
  ]);
});

test('it reads the rule of a procedure that names its own fields', () => {
  const contract = { imps: { fork: impContract.imps.fork } };

  expect(collectProcedureAccess(contract)).toStrictEqual([
    {
      path: 'imps.fork',
      access: { scope: 'manage', on: 'imp', fields: ['source', 'name'], noGrantable: true },
    },
  ]);
});
