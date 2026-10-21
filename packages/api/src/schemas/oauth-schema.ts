import * as z from 'zod';
import { NameSchema } from './name-schema';
import { ScopeSchema } from './token-schema';

const MAX_REDIRECT_URIS = 8;

export const RedirectUriSchema = z
  .string()
  .max(2048)
  .refine(
    isAllowedRedirectUri,
    'must be an https URL, or http on a loopback host, with no fragment',
  );

export const RedirectUrisSchema = z
  .array(RedirectUriSchema)
  .min(1)
  .max(MAX_REDIRECT_URIS)
  .refine((uris) => new Set(uris).size === uris.length, 'must not name a redirect URI twice');

export const GrantPatternSchema = z
  .string()
  .regex(
    /^(?:\*|[a-z][a-z0-9-]{0,30}|[a-z][a-z0-9-]{0,29}\*)$/u,
    'must be an imp name, or a name prefix and a trailing *, such as dev-*',
  );

export const ApprovalCodeSchema = z
  .string()
  .trim()
  .transform((code) => code.toUpperCase().replaceAll('-', ''))
  .pipe(
    z.string().regex(/^[A-HJ-NP-Z2-9]{8}$/u, 'must be the 8-symbol code the sign-in page shows'),
  );

export const OAuthClientSchema = z.object({
  name: NameSchema,

  clientId: z.string(),
  redirectUris: z.array(z.string()).readonly(),
  createdAt: z.date(),
});

export type OAuthClient = z.infer<typeof OAuthClientSchema>;

export const OAuthGrantSchema = z.object({
  id: z.string(),
  client: NameSchema,

  token: NameSchema,
  scope: ScopeSchema,
  imps: z.array(GrantPatternSchema).readonly().nullable(),
  createdAt: z.date(),

  lastUsedAt: z.date().nullable(),
});

export type OAuthGrant = z.infer<typeof OAuthGrantSchema>;

export const OAuthApprovalSchema = z.object({
  client: NameSchema,
  redirectUri: z.string(),

  requestedScope: ScopeSchema,
  requestedAt: z.date(),
  expiresAt: z.date(),
});

export type OAuthApproval = z.infer<typeof OAuthApprovalSchema>;

function isAllowedRedirectUri(text: string): boolean {
  let url: URL;

  try {
    url = new URL(text);
  } catch {
    return false;
  }

  if (text.includes('#')) {
    return false;
  }

  if (url.protocol === 'https:') {
    return true;
  }

  return url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
}
