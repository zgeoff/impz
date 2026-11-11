import { randomBytes, sign } from 'node:crypto';
import { IDENTITY_TOKEN_LIFE_S } from '@impz/api';
import type { IdentityKey } from './identity-key';

export interface IdentityImp {
  readonly id: string;
  readonly name: string;
}

export interface IdentityTokenInput {
  readonly key: IdentityKey;
  readonly issuer: string;
  readonly imp: IdentityImp;
  readonly audience: string;
  readonly nowSeconds: number;
}

// A compact ES256 JWT. The claims hold the imp and the audience and nothing
// the guest supplied.
export function buildIdentityToken(input: Readonly<IdentityTokenInput>): string {
  const header = { alg: 'ES256', typ: 'JWT', kid: input.key.jwk.kid };

  const claims = {
    iss: input.issuer,
    sub: input.imp.id,
    aud: input.audience,
    iat: input.nowSeconds,
    exp: input.nowSeconds + IDENTITY_TOKEN_LIFE_S,
    jti: randomBytes(16).toString('hex'),
    imp_name: input.imp.name,
  };

  const signingInput = `${encodeSegment(header)}.${encodeSegment(claims)}`;

  // JWS wants the raw r and s, not DER
  const signature = sign('sha256', Buffer.from(signingInput), {
    key: input.key.privateKey,
    dsaEncoding: 'ieee-p1363',
  });

  return `${signingInput}.${signature.toString('base64url')}`;
}

function encodeSegment(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
