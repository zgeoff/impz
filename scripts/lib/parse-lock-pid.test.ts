import { expect, test } from 'bun:test';
import { parseLockPid } from './parse-lock-pid';

test.each([
  ['a lock file that is gone', null],
  ['an empty lock file', ''],
  ['a lock file that holds no number', 'imp-bench'],
  ['a lock file that holds zero', '0'],
  ['a lock file that holds a fraction', '42.5'],
])('it reads no process from %s', (_label, text) => {
  expect(parseLockPid(text)).toBeNull();
});

test('it reads the process id a lock file holds', () => {
  expect(parseLockPid('4242')).toBe(4242);
});
