import { expect, test } from 'bun:test';
import { createTestDatabase } from '../platform/create-test-database';
import { seedUncleanOAuthClient } from './seed-unclean-oauth-client';

test('it stores the client under the name as given, with one redirect URI', async () => {
  const testDatabase = await createTestDatabase();

  await seedUncleanOAuthClient(testDatabase.db, {
    clientID: 'impc_tabbed',
    name: '  Spaced\tOrchard  ',
  });

  const row = await testDatabase.db
    .selectFrom('oauthClient')
    .selectAll()
    .where('clientId', '=', 'impc_tabbed')
    .executeTakeFirst();

  expect(row).toMatchObject({
    clientId: 'impc_tabbed',
    name: '  Spaced\tOrchard  ',
    redirectUris: '["https://client.example/callback"]',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
});
