import { randomBytes } from 'node:crypto';
import { mintSecret } from './mint-secret';
import type { OpaqueToken } from './parse-opaque-token';

const ID_BYTES = 12;

export function mintOpaqueToken(prefix: string): OpaqueToken & { readonly text: string } {
  const id = randomBytes(ID_BYTES).toString('base64url');
  const secret = mintSecret();

  return { id, secret, text: `${prefix}${id}.${secret}` };
}
