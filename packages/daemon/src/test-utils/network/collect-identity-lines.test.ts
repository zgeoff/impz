import { expect, test } from 'bun:test';
import { collectIdentityLines } from './collect-identity-lines';

test('it collects the values of the header under each spelling the name folds to', () => {
  const headers = new Headers();

  headers.append('Imp-Identity', 'a');
  headers.append('imp_identity', 'b');
  headers.append('x-keep', 'c');

  expect(collectIdentityLines(headers)).toStrictEqual(['a', 'b']);
});

test('it collects nothing from headers that hold none', () => {
  expect(collectIdentityLines(new Headers({ 'x-identity': 'a' }))).toStrictEqual([]);
});
