// The parts of an authorization request that stay the same from its login
// page to its consent page. better-auth signs each page's query afresh, so
// a sign-in binds to its consent through these.
export function buildConsentBinding(oauthQuery: string): string {
  const params = new URLSearchParams(oauthQuery);

  return JSON.stringify(
    ['client_id', 'redirect_uri', 'scope', 'resource', 'state', 'code_challenge'].map(
      (name) => params.get(name) ?? '',
    ),
  );
}
