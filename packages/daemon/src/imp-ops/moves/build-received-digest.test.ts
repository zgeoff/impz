import { expect, test } from 'bun:test';
import { buildReceivedDigest } from './build-received-digest';

test('it builds the same sha256 digest from the same sums', () => {
  expect(buildReceivedDigest('aa', 'bb')).toBe(buildReceivedDigest('aa', 'bb'));
});

test('it builds a sha256 digest', () => {
  expect(buildReceivedDigest('aa', 'bb')).toMatch(/^sha256:[\da-f]{64}$/v);
});

test('it builds another digest when the rootfs and config sums swap', () => {
  expect(buildReceivedDigest('aa', 'bb')).not.toBe(buildReceivedDigest('bb', 'aa'));
});
