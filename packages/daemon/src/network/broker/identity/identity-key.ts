import { createHash, createPublicKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { IdentityJwk } from '@impz/api';

export interface IdentityKey {
  readonly privateKey: KeyObject;
  readonly jwk: IdentityJwk;
}

// `kid` is the RFC 7638 thumbprint of the public key: SHA-256 over the
// required members in lexical order.
export function buildIdentityKey(privateKey: KeyObject): IdentityKey {
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  const x = jwk.x ?? '';
  const y = jwk.y ?? '';

  const thumbprint = createHash('sha256')
    .update(JSON.stringify({ crv: 'P-256', kty: 'EC', x, y }))
    .digest('base64url');

  return {
    privateKey,
    jwk: { kty: 'EC', crv: 'P-256', x, y, kid: thumbprint, alg: 'ES256', use: 'sig' },
  };
}
