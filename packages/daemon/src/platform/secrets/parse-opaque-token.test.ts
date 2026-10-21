import { expect, test } from 'bun:test';
import { parseOpaqueToken } from './parse-opaque-token';

test.each([
  ['a prefixed token', 'tok_', 'tok_AbC123.s3cr-et_', { id: 'AbC123', secret: 's3cr-et_' }],
  ['a token with no prefix', '', 'AbC123.s3cr-et_', { id: 'AbC123', secret: 's3cr-et_' }],
  ['a token with the wrong prefix', 'tok_', 'key_AbC123.s3cr-et_', null],
  ['a token with no prefix where one is due', 'tok_', 'AbC123.s3cr-et_', null],
  ['text with no dot', 'tok_', 'tok_AbC123', null],
  ['text with two dots', 'tok_', 'tok_AbC123.s3cr.et', null],
  ['an empty id', 'tok_', 'tok_.s3cr-et_', null],
  ['an empty secret', 'tok_', 'tok_AbC123.', null],
  ['empty text', '', '', null],
])('it parses %s', (_kind, prefix, text, expected) => {
  expect(parseOpaqueToken(prefix, text)).toStrictEqual(expected);
});
