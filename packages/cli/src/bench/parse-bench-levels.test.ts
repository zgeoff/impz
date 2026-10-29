import { expect, test } from 'bun:test';
import { parseBenchLevels } from './parse-bench-levels';

test('it reads each concurrency of a comma-separated list once, in order', () => {
  expect(parseBenchLevels('1, 4,16,4')).toStrictEqual([1, 4, 16]);
});

test.each([['0'], ['4,'], ['two'], ['1.5']])('it refuses %p as a concurrency list', (text) => {
  expect(() => parseBenchLevels(text)).toThrowWithMessage(
    Error,
    `--concurrency needs whole numbers above 0, such as 1,4,16, not ${text}`,
  );
});
