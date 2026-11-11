import { IDENTITY_LEEWAY_S, IDENTITY_TOKEN_LIFE_S } from '@impz/api';
import type { IdentityJwk, IdentityTrustDocument } from '@impz/api';
import * as z from 'zod';
import { decodeBase64Url } from './decode-base64url';
import { checkIdentityIssuers } from './load-identity-issuers';
import type { VerifiedImp, VerifyOptions } from './types';

const COMPACT_JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const TokenHeaderSchema = z.object({ alg: z.literal('ES256'), kid: z.string().min(1) });

const TokenClaimsSchema = z.object({
  iss: z.string().min(1),
  sub: z.string().min(1),
  aud: z.string(),
  iat: z.int(),
  exp: z.int(),
  imp_name: z.string(),
});

// Returns null for a token the service must refuse. Throws when the issuers
// are empty or name one issuer twice, a fault in the service's configuration.
export async function verifyImpIdentity(
  header: string | null,
  options: Readonly<VerifyOptions>,
): Promise<VerifiedImp | null> {
  checkIdentityIssuers(options.issuers);

  // a token holds no comma or space, so a repeated header, which a Headers
  // object joins with a comma, fails here
  if (header === null || !COMPACT_JWT.test(header)) {
    return null;
  }

  const [headerPart = '', claimsPart = '', signaturePart = ''] = header.split('.');

  const token = {
    header: parseSegment(headerPart, TokenHeaderSchema),
    claims: parseSegment(claimsPart, TokenClaimsSchema),
  };

  if (token.header === null || token.claims === null) {
    return null;
  }

  const claims = token.claims;
  const document = options.issuers.find((candidate) => candidate.issuer === claims.iss);
  const jwk = document?.keys.find((candidate) => candidate.kid === token.header?.kid);

  if (
    document === undefined ||
    jwk === undefined ||
    claims.aud !== options.audience ||
    !isInTime(claims, options.nowSeconds) ||
    isRetired(document, jwk.kid, claims.iat, options.nowSeconds) ||
    !(await probeSignature(jwk, `${headerPart}.${claimsPart}`, signaturePart))
  ) {
    return null;
  }

  return { issuer: claims.iss, id: claims.sub, name: claims.imp_name };
}

function parseSegment<T extends z.ZodType>(segment: string, schema: T): z.infer<T> | null {
  try {
    const bytes = decodeBase64Url(segment);

    if (bytes === null) {
      return null;
    }

    const parsed = schema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// A service accepts a token for 60 seconds after its `iat` at most: the 55 of
// its life and the 5 of leeway.
function isInTime(claims: Readonly<{ iat: number; exp: number }>, nowSeconds: number): boolean {
  return (
    claims.exp - claims.iat <= IDENTITY_TOKEN_LIFE_S &&
    nowSeconds <= claims.exp + IDENTITY_LEEWAY_S &&
    claims.iat <= nowSeconds + IDENTITY_LEEWAY_S
  );
}

// The second test reads the service's own clock, so a service up to 5 seconds
// behind impd still ends the old key by `at` plus 60 in impd's time.
function isRetired(
  document: Readonly<IdentityTrustDocument>,
  kid: string,
  iat: number,
  nowSeconds: number,
): boolean {
  const entry = document.retire.find((candidate) => candidate.kid === kid);

  return entry !== undefined && (iat >= entry.at || nowSeconds >= entry.at + IDENTITY_TOKEN_LIFE_S);
}

const ES256_SIGNATURE_BYTES = 64;

async function probeSignature(
  jwk: Readonly<IdentityJwk>,
  signingInput: string,
  signaturePart: string,
): Promise<boolean> {
  const signature = decodeBase64Url(signaturePart);

  if (signature === null || signature.byteLength !== ES256_SIGNATURE_BYTES) {
    return false;
  }

  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );

    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      signature,
      new TextEncoder().encode(signingInput),
    );
  } catch {
    return false;
  }
}
