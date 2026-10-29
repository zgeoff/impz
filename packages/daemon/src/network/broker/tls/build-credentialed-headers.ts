import { METHOD_OVERRIDE_HEADERS } from '@impz/api';
import type { Credential } from './admit-request';
import { buildEndToEndHeaders } from './build-end-to-end-headers';

export function buildCredentialedHeaders(source: Headers, credential: Credential): Headers {
  const headers = buildEndToEndHeaders(source);

  headers.delete('host');

  if (credential.filter !== null) {
    for (const name of METHOD_OVERRIDE_HEADERS) {
      headers.delete(name);
    }
  }

  headers.set(credential.header, credential.value);

  return headers;
}
