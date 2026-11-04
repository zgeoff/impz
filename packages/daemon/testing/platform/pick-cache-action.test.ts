import { expect, test } from 'bun:test';
import { pickCacheAction } from './pick-cache-action';

test.each<[ReturnType<typeof pickCacheAction>, string, boolean, boolean]>([
  ['build', 'no template exists and nothing is copied', false, false],
  ['copy', 'the template exists and nothing is copied', true, false],
  ['done', 'the copy is written', true, true],
  ['done', 'the copy is written and a sweep then removed the template', false, true],
])('it picks %s when %s', (action, _, hasTemplate, copied) => {
  expect(pickCacheAction(hasTemplate, copied)).toBe(action);
});
