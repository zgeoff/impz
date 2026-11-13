import type { OAuthClientID } from '@zgeoff/mcp-auth';
import { toTagged } from '@zgeoff/std';
import type { ImpDatabase } from '../../platform/db/open-database';

interface UncleanOAuthClientInput {
  readonly clientID: string;
  readonly name: string;
}

// A client an older app stored under a name it never cleaned, such as one with a tab: the shared
// OAuth server cleans each name it stores, and refuses a second client whose name cleans alike.
export async function seedUncleanOAuthClient(
  db: ImpDatabase,
  input: Readonly<UncleanOAuthClientInput>,
) {
  await db
    .insertInto('oauthClient')
    .values({
      id: crypto.randomUUID(),
      clientId: input.clientID,
      name: input.name,
      redirectUris: JSON.stringify(['https://client.example/callback']),
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    .execute();

  return { clientID: toTagged<OAuthClientID>(input.clientID), name: input.name };
}
