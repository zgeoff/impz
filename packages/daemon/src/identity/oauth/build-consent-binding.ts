export function buildConsentBinding(oauthQuery: string): string {
  const params = new URLSearchParams(oauthQuery);

  // better-auth signs each page's query afresh, so a sign-in binds to its
  // consent through these parts, not the whole query
  return JSON.stringify(
    ['client_id', 'redirect_uri', 'scope', 'resource', 'state', 'code_challenge'].map(
      (name) => params.get(name) ?? '',
    ),
  );
}
