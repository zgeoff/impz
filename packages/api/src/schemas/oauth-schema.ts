import * as z from 'zod';
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

// An older database can hold a client name that a new client may not take, such as one with a
// space, so a command names a client by its client ID or by any stored name.
export const OAuthClientReferenceSchema = z.string().min(1).max(200);

export const OAuthClientSchema = z.object({
  name: z.string(),

  clientId: z.string(),
  redirectUris: z.array(z.string()).readonly(),
  createdAt: z.date(),
});

export type OAuthClient = z.infer<typeof OAuthClientSchema>;

export const OAuthGrantSchema = z.object({
  id: z.string(),
  client: z.string(),

  // passkey, or token: and the name of the imp token that approved a grant before the owner's
  // passkey approved each one
  approvedBy: z.string(),
  scope: ScopeSchema,
  createdAt: z.date(),

  lastUsedAt: z.date().nullable(),
});

export type OAuthGrant = z.infer<typeof OAuthGrantSchema>;

export const OAuthPasskeySchema = z.object({
  id: z.string(),
  createdAt: z.date(),
  lastUsedAt: z.date().nullable(),
});

export type OAuthPasskey = z.infer<typeof OAuthPasskeySchema>;

// The owner opens the page at url and enters the token, which works once. url is null when impd
// serves no public MCP route.
export const OAuthEnrollmentSchema = z.object({
  token: z.string(),
  url: z.string().nullable(),
});

export type OAuthEnrollment = z.infer<typeof OAuthEnrollmentSchema>;

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
