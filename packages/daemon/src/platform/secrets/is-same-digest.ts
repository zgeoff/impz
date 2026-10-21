import { timingSafeEqual } from 'node:crypto';

export function isSameDigest(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}
