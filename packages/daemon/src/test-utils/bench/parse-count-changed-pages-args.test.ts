import { expect, test } from 'bun:test';
import { parseCountChangedPagesArgs } from './parse-count-changed-pages-args';

test('it reads the base and the snapshot paths', () => {
  expect(parseCountChangedPagesArgs(['/var/lib/imp/base', '/var/lib/imp/mem'])).toStrictEqual({
    basePath: '/var/lib/imp/base',
    nextPath: '/var/lib/imp/mem',
  });
});

test.each([
  [
    'no path',
    [],
    "Positional argument 'base' is required; Positional argument 'snapshot' is required",
  ],
  ['one path', ['/var/lib/imp/base'], "Positional argument 'snapshot' is required"],
])('it refuses %s with the positional it lacks', (_label, argv, refusal) => {
  expect(parseCountChangedPagesArgs(argv)).toBe(refusal);
});
