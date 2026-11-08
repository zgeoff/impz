import { expect, mock, test } from 'bun:test';
import { pruneEvents } from '@impz/durable';
import { sql } from 'kysely';
import { createTestDatabase } from '../../test-utils/platform/create-test-database';
import { readImpEventsAfter } from './read-imp-events-after';
import { tailImpEvents } from './tail-imp-events';
import { withImpTransaction } from './with-imp-transaction';

async function setupTest() {
  const database = await createTestDatabase();

  const db = database.db;

  return {
    db,
    tail: (after: number, signal: AbortSignal, onReadError?: (error: unknown) => void) =>
      tailImpEvents({
        changes: db.log.changes,
        readAfter: (cursor) => readImpEventsAfter(db, { after: cursor, limit: 2 }),
        after,
        signal,
        ...(onReadError !== undefined && { onReadError }),
      }),
  };
}

test('it yields each page of the backlog, then the page a later commit adds', async () => {
  const ctx = await setupTest();

  const controller = new AbortController();

  for (const name of ['first', 'second', 'third']) {
    await ctx.db.log.write(
      {
        ev: 'GovernorDecision',
        decision: 'admitted',
        name,
        trigger: 'wake',
        usedMib: 512,
        budgetMib: 4096,
      },
      Date.UTC(2026, 9, 2, 12),
    );
  }

  const pages = ctx.tail(0, controller.signal);
  const backlog = [await pages.next(), await pages.next()];
  const later = pages.next();

  await ctx.db.log.write(
    {
      ev: 'GovernorDecision',
      decision: 'admitted',
      name: 'later',
      trigger: 'wake',
      usedMib: 512,
      budgetMib: 4096,
    },
    Date.UTC(2026, 9, 2, 12),
  );

  const added = await later;

  controller.abort();

  expect([...backlog, added]).toMatchObject([
    {
      done: false,
      value: [
        { name: 'first', seq: 1 },
        { name: 'second', seq: 2 },
      ],
    },
    { done: false, value: [{ name: 'third', seq: 3 }] },
    { done: false, value: [{ name: 'later', seq: 4 }] },
  ]);
});

test('it returns the reset when a prune passes its cursor', async () => {
  const ctx = await setupTest();

  await ctx.db.log.write(
    {
      ev: 'GovernorDecision',
      decision: 'admitted',
      name: 'pruned',
      trigger: 'wake',
      usedMib: 512,
      budgetMib: 4096,
    },
    Date.UTC(2026, 9, 2, 12),
  );

  await ctx.db.log.write(
    {
      ev: 'GovernorDecision',
      decision: 'admitted',
      name: 'pruned-too',
      trigger: 'wake',
      usedMib: 512,
      budgetMib: 4096,
    },
    Date.UTC(2026, 9, 2, 12),
  );

  await withImpTransaction(ctx.db, (trx) => pruneEvents(trx, Date.UTC(2026, 9, 20)));

  const step = await ctx.tail(0, new AbortController().signal).next();

  expect(step).toStrictEqual({ done: true, value: { kind: 'reset', prunedThrough: 2 } });
});

test('it returns null once its signal aborts', async () => {
  const ctx = await setupTest();

  const controller = new AbortController();

  const waiting = ctx.tail(0, controller.signal).next();

  controller.abort();

  const step = await waiting;

  expect(step).toStrictEqual({ done: true, value: null });
});

test('it reports a failed read, and reads again after the next commit', async () => {
  const ctx = await setupTest();

  const controller = new AbortController();

  const onReadError = mock<(error: unknown) => void>(() => {});

  await sql`ALTER TABLE events RENAME TO events_away`.execute(ctx.db);

  const pages = ctx.tail(0, controller.signal, onReadError);
  const next = pages.next();

  await sql`ALTER TABLE events_away RENAME TO events`.execute(ctx.db);

  await ctx.db.log.write(
    {
      ev: 'GovernorDecision',
      decision: 'admitted',
      name: 'after',
      trigger: 'wake',
      usedMib: 512,
      budgetMib: 4096,
    },
    Date.UTC(2026, 9, 2, 12),
  );

  const step = await next;

  controller.abort();

  expect({ step, reports: onReadError.mock.calls.length }).toMatchObject({
    step: { done: false, value: [{ name: 'after', seq: 1 }] },
    reports: 1,
  });
});

test('it ends with the failure of a read when nothing takes it', async () => {
  const ctx = await setupTest();

  await sql`ALTER TABLE events RENAME TO events_away`.execute(ctx.db);

  expect(ctx.tail(0, new AbortController().signal).next()).rejects.toThrow(/events/u);
});
