import { expect, test } from 'bun:test';
import { buildBenchImpName } from './build-bench-imp-name';

test('it names an imp by its prefix, its concurrency and its index', () => {
  expect(buildBenchImpName('bench-c0ffee15a7e1-', 16, 3)).toBe('bench-c0ffee15a7e1-16-3');
});
