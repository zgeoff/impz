import { expect, test } from 'bun:test';
import { parseBenchArgs } from './parse-bench-args';

test('it reads the bench options as impz bench does, with its defaults', () => {
  expect(parseBenchArgs(['wake', '--concurrency', '1,4', '--memory', '256m'])).toStrictEqual({
    scenarios: 'wake',
    concurrency: '1,4',
    samples: '20',
    memory: '256m',
    awake: '0',
  });
});

test('it reads an option given with an equals sign', () => {
  expect(parseBenchArgs(['--memory=384m'])).toMatchObject({ memory: '384m' });
});

test('it refuses an option that lacks its value', () => {
  expect(parseBenchArgs(['--memory'])).toBe("Optional argument '--memory' requires a value");
});
