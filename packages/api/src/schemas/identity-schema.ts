import * as z from 'zod';

// Letters, digits and . _ - only, so an issuer is safe in a log line, a file
// name and a JSON document alike.
export const IdentityIssuerSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,128}$/u, 'must be 1 to 128 letters, digits, ".", "_" or "-"');

const Base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/u);

const IdentityJwkSchema = z.object({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: Base64UrlSchema,
  y: Base64UrlSchema,
  kid: z.string().min(1).max(128),
  alg: z.literal('ES256'),
  use: z.literal('sig'),
});

export type IdentityJwk = z.infer<typeof IdentityJwkSchema>;

// A JWK Set (RFC 7517) with two more members, which the RFC allows. `issuer`
// binds the keys to one impd. `retire` is empty outside a key change; during
// one it names the old key and the second at which impd stops signing with it.
const RetireEntrySchema = z.object({ kid: z.string().min(1).max(128), at: z.int().nonnegative() });

export const IdentityTrustDocumentSchema = z.object({
  issuer: IdentityIssuerSchema,
  keys: z.array(IdentityJwkSchema).min(1).max(2).readonly(),
  retire: z.array(RetireEntrySchema).max(1).readonly(),
});

export type IdentityTrustDocument = z.infer<typeof IdentityTrustDocumentSchema>;

export const IdentityStageKeyInputSchema = z.object({ at: z.date() });

// A token lives 55 seconds, and a service allows 5 seconds of clock
// difference, so a service accepts a token for 60 seconds after its `iat` at
// most.
export const IDENTITY_TOKEN_LIFE_S = 55;
export const IDENTITY_LEEWAY_S = 5;
