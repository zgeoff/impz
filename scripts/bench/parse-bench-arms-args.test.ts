import { expect, test } from 'bun:test';
import { BENCH_ARMS_USAGE, parseBenchArmsArgs } from './parse-bench-arms-args';

test('it reads the arms in order, the rounds, and the bench arguments after --', () => {
  const args = parseBenchArmsArgs([
    '--out',
    'results',
    '--rounds',
    '2',
    '--arm',
    'baseline=/work/base',
    '--arm',
    'candidate=.',
    '--',
    'wake',
    '--concurrency',
    '1,4',
  ]);

  expect(args).toStrictEqual({
    arms: [
      { name: 'baseline', checkout: '/work/base' },
      { name: 'candidate', checkout: '.' },
    ],
    rounds: 2,
    out: 'results',
    benchArgs: ['wake', '--concurrency', '1,4'],
  });
});

test('it runs one round and the default bench when it is given neither', () => {
  expect(parseBenchArmsArgs(['--out', 'results', '--arm', 'only=.'])).toStrictEqual({
    arms: [{ name: 'only', checkout: '.' }],
    rounds: 1,
    out: 'results',
    benchArgs: [],
  });
});

test('it refuses an arm without a checkout', () => {
  expect(parseBenchArmsArgs(['--out', 'results', '--arm', 'baseline'])).toBe(
    'bench arms: an arm is <name>=<checkout>, not baseline',
  );
});

test.each([
  ['no arm', ['--out', 'results']],
  ['no out dir', ['--arm', 'only=.']],
  ['no rounds', ['--out', 'results', '--arm', 'only=.', '--rounds', '0']],
  ['an unknown option', ['--out', 'results', '--arm', 'only=.', '--fast']],
])('it answers %s with the usage', (_, argv) => {
  expect(parseBenchArmsArgs(argv)).toBe(BENCH_ARMS_USAGE);
});
