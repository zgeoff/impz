import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { IdentityJwk } from '@impz/api';

export interface StubIdentityKey {
  readonly privateKey: KeyObject;
  readonly jwk: IdentityJwk;
}

export function buildStubIdentityKey(kid: string): StubIdentityKey {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const privateKey = pair.privateKey;
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  const x = jwk.x ?? '';
  const y = jwk.y ?? '';

  return { privateKey, jwk: { kty: 'EC', crv: 'P-256', x, y, kid, alg: 'ES256', use: 'sig' } };
}

interface StubIdentityTokenInput {
  readonly key: StubIdentityKey;
  readonly claims: Readonly<Record<string, unknown>>;
  readonly alg?: string;
}

// A signed token with the claims exactly as given, so a test can build one
// that impd would never sign.
export function buildStubIdentityToken(input: Readonly<StubIdentityTokenInput>): string {
  const header = { alg: input.alg ?? 'ES256', typ: 'JWT', kid: input.key.jwk.kid };
  const signingInput = `${encode(header)}.${encode(input.claims)}`;

  const signature = sign('sha256', Buffer.from(signingInput), {
    key: input.key.privateKey,
    dsaEncoding: 'ieee-p1363',
  });

  return `${signingInput}.${signature.toString('base64url')}`;
}

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
