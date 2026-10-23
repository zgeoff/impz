import { expect, test } from 'bun:test';
import { parseStoredPolicy } from './egress';

test('#parseStoredPolicy reads a stored leading-zero IPv4 entry as decimal', () => {
  expect(parseStoredPolicy('box', '["008.0.0.1"]')).toStrictEqual({
    mode: 'box',
    allow: ['8.0.0.1'],
  });
});
