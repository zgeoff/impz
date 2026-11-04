import { expect, test } from 'bun:test';
import { formatRunPrefix } from './format-run-prefix';

test('it formats the PID and the PID namespace as a name prefix', () => {
  expect(formatRunPrefix({ pid: 4182, namespace: '4026531836' })).toBe('pid4182-ns4026531836-');
});
