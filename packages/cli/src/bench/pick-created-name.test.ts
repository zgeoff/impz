import { expect, test } from 'bun:test';
import { ORPCError } from '@impz/client';
import { pickCreatedName } from './pick-created-name';

test.each([
  ['a name impd refused as held', new ORPCError('CONFLICT'), true, 'none'],
  [
    'a connection refused before the create was sent',
    Object.assign(new TypeError('Unable to connect'), { code: 'ECONNREFUSED' }),
    false,
    'none',
  ],
  [
    'a timeout, with the name taken since',
    new DOMException('The operation timed out.', 'TimeoutError'),
    true,
    'leftover',
  ],
  [
    'a timeout, with no imp under the name',
    new DOMException('The operation timed out.', 'TimeoutError'),
    false,
    'none',
  ],
  [
    'a connection reset, with the name taken since',
    Object.assign(new TypeError('socket closed'), { code: 'ECONNRESET' }),
    true,
    'leftover',
  ],
  ['a boot failure that left an imp', new ORPCError('INTERNAL_SERVER_ERROR'), true, 'leftover'],
  ['a create impd refused before making the imp', new ORPCError('BAD_REQUEST'), false, 'none'],
  ['any other error, with the name taken', new Error('the bench broke'), true, 'leftover'],
] as const)(
  'it decides what the run holds after a failed create: %s',
  (_label, error, isNameHeld, outcome) => {
    expect(pickCreatedName({ error, isNameHeld })).toBe(outcome);
  },
);
