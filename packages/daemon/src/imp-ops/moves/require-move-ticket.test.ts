import { expect, test } from 'bun:test';
import { buildMockMoveTicketRow } from '../../../testing/imp-ops/build-mock-move-ticket-row';
import { createTestDatabase } from '../../../testing/platform/create-test-database';
import { writeMoveTicket } from '../../platform/db/move-tickets';
import { hashSecret } from '../../platform/secrets/hash-secret';
import { requireMoveTicket } from './require-move-ticket';

async function setupTest() {
  const database = await createTestDatabase();

  return { db: database.db };
}

test('it returns the ticket row for a known ticket and its secret', async () => {
  const ctx = await setupTest();

  const row = buildMockMoveTicketRow({
    id: 'ticket-1',
    secret_sha256: hashSecret('s3cret').toString('hex'),
  });

  await writeMoveTicket(ctx.db, row);

  const checked = await requireMoveTicket(
    ctx.db,
    new Request('http://peer.test/move/commit', {
      headers: { authorization: 'ImpMove ticket-1.s3cret' },
    }),
  );

  expect(checked).toStrictEqual({ row, ticket: { id: 'ticket-1', secret: 's3cret' } });
});

test.each([
  ['no Authorization header', {}, 'no move ticket in the Authorization header'],
  ['an empty header', { authorization: '' }, 'no move ticket in the Authorization header'],
  [
    'a Bearer token',
    { authorization: 'Bearer ticket-1.s3cret' },
    'no move ticket in the Authorization header',
  ],
  [
    'the scheme in lowercase',
    { authorization: 'impmove ticket-1.s3cret' },
    'no move ticket in the Authorization header',
  ],
  [
    'a ticket with no secret',
    { authorization: 'ImpMove ticket-1' },
    'no move ticket in the Authorization header',
  ],
  [
    'a ticket with no id',
    { authorization: 'ImpMove .s3cret' },
    'no move ticket in the Authorization header',
  ],
  [
    'a ticket with an extra part',
    { authorization: 'ImpMove ticket-1.s3cret.extra' },
    'no move ticket in the Authorization header',
  ],
  ['an unknown ticket id', { authorization: 'ImpMove ticket-2.s3cret' }, 'unknown move ticket'],
  ['the wrong secret', { authorization: 'ImpMove ticket-1.guessed' }, 'unknown move ticket'],
  [
    'the stored hash as the secret',
    { authorization: `ImpMove ticket-1.${hashSecret('s3cret').toString('hex')}` },
    'unknown move ticket',
  ],
])('it refuses %s', async (_label, headers, message) => {
  const ctx = await setupTest();

  await writeMoveTicket(
    ctx.db,
    buildMockMoveTicketRow({ id: 'ticket-1', secret_sha256: hashSecret('s3cret').toString('hex') }),
  );

  expect(
    requireMoveTicket(ctx.db, new Request('http://peer.test/move/commit', { headers })),
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED', message });
});
