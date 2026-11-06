import { expect, test } from 'bun:test';
import { toCanonicalJson } from './to-canonical-json';

test('it writes the same text for objects whose keys differ only in order', () => {
  const first = toCanonicalJson({ name: 'shelf', size: { width: 2, depth: 1 } });
  const second = toCanonicalJson({ size: { depth: 1, width: 2 }, name: 'shelf' });

  expect(second).toBe(first);
});

test('it keeps the order of array items', () => {
  const text = toCanonicalJson({ tags: ['b', 'a'] });

  expect(text).toBe('{"tags":["b","a"]}');
});

test('it writes a scalar as JSON', () => {
  const text = toCanonicalJson('plain');

  expect(text).toBe('"plain"');
});
