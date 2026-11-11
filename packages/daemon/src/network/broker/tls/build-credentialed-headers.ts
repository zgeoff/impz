import { IDENTITY_HEADER, METHOD_OVERRIDE_HEADERS } from '@impz/api';
import type { Credential } from './admit-request';
import { buildEndToEndHeaders } from './build-end-to-end-headers';

// `identityToken` is null when the rule has no identity or impd has no issuer.
// The token goes last, so nothing the guest sent can follow or replace it.
export function buildCredentialedHeaders(
  source: Headers,
  credential: Credential,
  identityToken: string | null,
): Headers {
  const headers = buildEndToEndHeaders(source);

  headers.delete('host');

  if (credential.filter !== null) {
    for (const name of METHOD_OVERRIDE_HEADERS) {
      headers.delete(name);
    }
  }

  stripIdentityHeaders(headers);

  headers.set(credential.header, credential.value);

  if (identityToken !== null) {
    headers.set(IDENTITY_HEADER, identityToken);
  }

  return headers;
}

// Some servers fold an underscore into a hyphen, so `imp_identity` reaches
// them as the header this function must remove. A Headers object lower-cases
// names, and a delete removes every line of a name.
function stripIdentityHeaders(headers: Headers): void {
  const names: string[] = [];

  for (const name of headers.keys()) {
    if (name.replaceAll('_', '-') === IDENTITY_HEADER) {
      names.push(name);
    }
  }

  for (const name of names) {
    headers.delete(name);
  }
}
