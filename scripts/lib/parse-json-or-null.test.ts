import { expect, test } from 'bun:test';
import { parseJSONOrNull } from './parse-json-or-null';

test('it parses JSON text', () => {
  expect(parseJSONOrNull('{"defaults":{"image":"base"}}')).toStrictEqual({
    defaults: { image: 'base' },
  });
});

test('it reads text that is not JSON as null', () => {
  expect(parseJSONOrNull('impd is starting')).toBeNull();
});
