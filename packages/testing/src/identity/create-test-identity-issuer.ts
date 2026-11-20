import { IDENTITY_HEADER as API_IDENTITY_HEADER, IDENTITY_TOKEN_LIFE_S } from '@impz/api';
import type { IdentityTrustDocument } from '@impz/client/identity';

// the header that carries an imp's identity token to a service
export const IDENTITY_HEADER: string = API_IDENTITY_HEADER;

export interface TokenClaimsInput {
  // `sub`: the imp's ID
  readonly id: string;

  // `imp_name`
  readonly name: string;
  readonly audience: string;

  // seconds; defaults to nowSeconds
  readonly iat?: number;

  // seconds; defaults to iat plus the 55 s of a token's life
  readonly exp?: number;

  // the clock that iat defaults to, in seconds; defaults to the real clock
  readonly nowSeconds?: number;
}

export interface TestIdentityIssuer {
  readonly issuer: string;
  readonly kid: string;

  // one public key and no retire entry, for loadIdentityIssuers
  readonly document: IdentityTrustDocument;
  readonly signToken: (claims: TokenClaimsInput) => Promise<string>;

  // signs with a fresh key under this issuer and kid, so the token fails against `document`
  readonly forge: (claims: TokenClaimsInput) => Promise<string>;

  // a copy of `document` whose retire entry names the key
  readonly retire: (at: number) => IdentityTrustDocument;
}

export interface TestIdentityIssuerOptions {
  readonly issuer: string;

  // defaults to `<issuer>-key-1`, so two issuers never share one
  readonly kid?: string;
}

const ES256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;

// A copy of the token impd's broker mints, which the identity token's test checks against the verifier.
export async function createTestIdentityIssuer(
  options: Readonly<TestIdentityIssuerOptions>,
): Promise<TestIdentityIssuer> {
  const issuer = options.issuer;
  const kid = options.kid ?? `${issuer}-key-1`;

  const pair = await crypto.subtle.generateKey(ES256, true, ['sign', 'verify']);
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);

  const document: IdentityTrustDocument = {
    issuer,
    keys: [
      {
        kty: 'EC',
        crv: 'P-256',
        x: publicJwk.x ?? '',
        y: publicJwk.y ?? '',
        kid,
        alg: 'ES256',
        use: 'sig',
      },
    ],
    retire: [],
  };

  return {
    issuer,
    kid,
    document,
    signToken: (claims) => signToken(pair.privateKey, { issuer, kid, claims }),
    forge: async (claims) => {
      const stranger = await crypto.subtle.generateKey(ES256, true, ['sign', 'verify']);

      return signToken(stranger.privateKey, { issuer, kid, claims });
    },
    retire: (at) => ({ ...document, retire: [{ kid, at }] }),
  };
}

async function signToken(
  key: CryptoKey,
  input: Readonly<{ issuer: string; kid: string; claims: TokenClaimsInput }>,
): Promise<string> {
  const claims = input.claims;
  const iat = claims.iat ?? claims.nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', typ: 'JWT', kid: input.kid };

  const payload = {
    iss: input.issuer,
    sub: claims.id,
    aud: claims.audience,
    iat,
    exp: claims.exp ?? iat + IDENTITY_TOKEN_LIFE_S,
    jti: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex'),
    imp_name: claims.name,
  };

  const signingInput = `${encodeSegment(header)}.${encodeSegment(payload)}`;

  // WebCrypto answers the raw r and s a JWS wants
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${Buffer.from(signature).toString('base64url')}`;
}

function encodeSegment(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
