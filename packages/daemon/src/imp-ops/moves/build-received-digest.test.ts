import { expect, test } from 'bun:test';
import { buildReceivedDigest } from './build-received-digest';

test('it builds the sha256 of the rootfs and config lines', () => {
  expect(buildReceivedDigest('aa', 'bb')).toBe(
    'sha256:7fdf9a3074a24a02e4c63499dd1831e7ff7b22a722fc4f7215d15aafce9d3f4c',
  );
});

test('it builds the same sha256 digest from the same sums', () => {
  expect(buildReceivedDigest('aa', 'bb')).toBe(buildReceivedDigest('aa', 'bb'));
});

test('it builds a sha256 digest', () => {
  expect(buildReceivedDigest('aa', 'bb')).toMatch(/^sha256:[\da-f]{64}$/v);
});

test('it builds another digest when the rootfs and config sums swap', () => {
  expect(buildReceivedDigest('aa', 'bb')).not.toBe(buildReceivedDigest('bb', 'aa'));
});
