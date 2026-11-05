import { expect, test } from 'bun:test';
import { formatPageHandler } from './format-page-handler';

test('it formats the faults, the data blocks and the serve time of a page handler', () => {
  expect(formatPageHandler({ faults: 214, blocks: 151, serveMs: 388 })).toBe(
    '; page handler faults=214 blocks=151 serve=388ms',
  );
});

test('it formats nothing for a wake with no page handler', () => {
  expect(formatPageHandler(undefined)).toBe('');
});
