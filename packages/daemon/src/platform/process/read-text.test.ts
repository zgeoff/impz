import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { readText } from './read-text';

test('it reads a file as utf8 text, such as the café in this title', () => {
  expect(readText(import.meta.path)).toContain('such as the café in this title');
});

test('it throws for a file that is missing', () => {
  expect(() => readText(join(import.meta.dir, 'missing.txt'))).toThrow(/ENOENT/u);
});
