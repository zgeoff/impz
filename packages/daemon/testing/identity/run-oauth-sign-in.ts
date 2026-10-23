import * as z from 'zod';
import { PKCE_VERIFIER } from './create-pending-sign-in';
import type { SignInRoute } from './create-pending-sign-in';
import { runOAuthConsent } from './run-oauth-consent';

const TokensSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  scope: z.string(),
});

type RouteTokens = z.infer<typeof TokensSchema>;

export async function runOAuthSignIn(
  route: Readonly<SignInRoute>,
  approve: (code: string) => void | Promise<void>,
): Promise<RouteTokens> {
  const code = await runOAuthConsent(route, approve);

  const exchanged = await route.respond(
    new Request(`${route.origin}/oauth2/token`, {
      method: 'POST',
      headers: {
        host: new URL(route.origin).host,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: route.clientID,
        code,
        redirect_uri: route.redirectURI,
        code_verifier: PKCE_VERIFIER,
        resource: `${route.origin}/mcp`,
      }),
    }),
  );

  const body: unknown = await exchanged.json();

  const tokens = TokensSchema.safeParse(body);

  if (!tokens.success) {
    throw new Error(
      `the token request answered ${String(exchanged.status)}: ${JSON.stringify(body)}`,
    );
  }

  return tokens.data;
}
