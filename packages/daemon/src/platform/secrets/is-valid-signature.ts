import { isSameDigest } from './is-same-digest';
import { sign } from './sign';

export function isValidSignature(
  key: string | Uint8Array,
  text: string,
  signature: string,
  encoding: 'base64url' | 'hex',
): boolean {
  return isSameDigest(Buffer.from(signature), Buffer.from(sign(key, text).toString(encoding)));
}
