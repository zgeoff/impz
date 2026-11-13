import { expect, test } from 'bun:test';
import { buildMockTokenRecord } from '../../test-utils/identity/build-mock-token-record';
import { buildMockTokenSshKeyRecord } from '../../test-utils/identity/build-mock-token-ssh-key-record';
import { createTestDatabase } from '../../test-utils/platform/create-test-database';
import {
  listTokenRecords,
  listTokenSshKeyRecords,
  removeTokenRecord,
  writeTokenRecord,
} from './tokens';

async function setupTest() {
  const database = await createTestDatabase();

  return { db: database.db };
}

test('#removeTokenRecord removes the token and its SSH keys', async () => {
  const ctx = await setupTest();

  const token = buildMockTokenRecord();

  await writeTokenRecord(ctx.db, token, [buildMockTokenSshKeyRecord({ tokenId: token.id })]);
  await removeTokenRecord(ctx.db, token.id);

  expect({
    tokens: await listTokenRecords(ctx.db),
    keys: await listTokenSshKeyRecords(ctx.db),
  }).toStrictEqual({ tokens: [], keys: [] });
});

test('#removeTokenRecord never removes another token', async () => {
  const ctx = await setupTest();

  const gone = buildMockTokenRecord();
  const kept = buildMockTokenRecord();

  await writeTokenRecord(ctx.db, gone, []);
  await writeTokenRecord(ctx.db, kept, []);
  await removeTokenRecord(ctx.db, gone.id);

  const tokens = await listTokenRecords(ctx.db);

  expect(tokens.map((token) => token.id)).toStrictEqual([kept.id]);
});
