import { expect, test } from 'bun:test';
import { toSendableCloseCode } from './to-sendable-close-code';

test.each([
  [1000, 1000],
  [1001, 1001],
  [1008, 1008],
  [1014, 1014],
  [3000, 3000],
  [4999, 4999],
])('it keeps the sendable code %d', (code, expected) => {
  expect(toSendableCloseCode(code)).toBe(expected);
});

test.each([
  [1005, 1000],
  [1006, 1000],
  [1015, 1000],
  [2999, 1000],
  [5000, 1000],
])('it sends %d, which only describes a close, as 1000', (code, expected) => {
  expect(toSendableCloseCode(code)).toBe(expected);
});
