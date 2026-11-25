import { expect, test } from 'bun:test';
import { getImageAliases } from './get-image-aliases';

test('#getImageAliases returns the aliases of an image', () => {
  expect(getImageAliases({ aliases: ['agent', 'stable'] })).toStrictEqual(['agent', 'stable']);
});

test('#getImageAliases returns none for an image from an impd that sends no aliases', () => {
  expect(getImageAliases({})).toStrictEqual([]);
});
