import { createPendingSignIn } from './create-pending-sign-in';
import type { SignInRoute } from './create-pending-sign-in';

export async function runOAuthConsent(
  route: Readonly<SignInRoute>,
  approve: (code: string) => void | Promise<void>,
): Promise<string> {
  const host = new URL(route.origin).host;

  const pending = await createPendingSignIn(route);

  await approve(pending.code);

  const form = {
    host,
    'content-type': 'application/x-www-form-urlencoded',
    origin: route.origin,
  };

  const continued = await route.respond(
    new Request(`${route.origin}/login`, {
      method: 'POST',
      headers: form,
      body: new URLSearchParams({ oauth_query: pending.oauthQuery, action: 'continue' }),
    }),
  );

  const consentURL = new URL(continued.headers.get('location') ?? '/', route.origin);

  const cookie = continued.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  if (consentURL.pathname !== '/consent') {
    throw new Error(`Continue answered ${String(continued.status)}, not a redirect to consent`);
  }

  const consentQuery = consentURL.search.slice(1);

  const allowed = await route.respond(
    new Request(`${route.origin}/consent`, {
      method: 'POST',
      headers: { ...form, cookie },
      body: new URLSearchParams({ oauth_query: consentQuery, action: 'allow' }),
    }),
  );

  const back = new URL(allowed.headers.get('location') ?? route.redirectURI);

  const code = back.searchParams.get('code');

  if (code === null) {
    throw new Error(`Allow answered ${String(allowed.status)} with no code: ${back.href}`);
  }

  return code;
}
