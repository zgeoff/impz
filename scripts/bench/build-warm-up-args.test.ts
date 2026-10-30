import { expect, test } from 'bun:test';
import { buildWarmUpArgs } from './build-warm-up-args';

test("it carries the timed run's --memory value over to the warm-up", () => {
  expect(
    buildWarmUpArgs(['create,wake', '--concurrency', '1,4', '--memory', '256m', '--samples', '20']),
  ).toStrictEqual(['bench', 'create', '--concurrency', '1', '--samples', '3', '--memory', '256m']);
});

test('it carries a --memory=<size> flag over whole', () => {
  expect(buildWarmUpArgs(['wake', '--memory=512m'])).toStrictEqual([
    'bench',
    'create',
    '--concurrency',
    '1',
    '--samples',
    '3',
    '--memory=512m',
  ]);
});

test('it warms the default size when the timed run sets no memory', () => {
  expect(buildWarmUpArgs(['create', '--samples', '20'])).toStrictEqual([
    'bench',
    'create',
    '--concurrency',
    '1',
    '--samples',
    '3',
  ]);
});
