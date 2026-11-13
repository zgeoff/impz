import type { ClientView, OAuthClientID } from '@zgeoff/mcp-auth';

export type PickedOAuthClient =
  | { readonly kind: 'found'; readonly client: ClientView }
  | { readonly kind: 'missing' }
  | { readonly kind: 'ambiguous'; readonly clientIDs: readonly OAuthClientID[] };

// A command names a client by its client ID or its name. An older database can hold two names that
// clean to the same text, so a name that matches more than one client picks none.
export function pickOAuthClient(
  reference: string,
  clients: readonly ClientView[],
  named: readonly ClientView[],
): PickedOAuthClient {
  const byID = clients.find((client) => client.clientID === reference);

  if (byID !== undefined) {
    return { kind: 'found', client: byID };
  }

  const [first, ...rest] = named;

  if (first === undefined) {
    return { kind: 'missing' };
  }

  if (rest.length > 0) {
    return { kind: 'ambiguous', clientIDs: named.map((client) => client.clientID) };
  }

  return { kind: 'found', client: first };
}
