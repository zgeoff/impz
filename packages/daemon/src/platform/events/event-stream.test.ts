import { expect, mock, test } from 'bun:test';
import type { ImpEvent } from '@impz/api';
import { pruneEvents } from '@impz/durable';
import invariant from 'tiny-invariant';
import { readApiEvent } from '../../surface/read-api-event';
import { buildStubClock } from '../../test-utils/platform/build-stub-clock';
import { createTestDatabase } from '../../test-utils/platform/create-test-database';
import { buildMockGovernorDecision } from '../../test-utils/vm/build-mock-governor-decision';
import { appendImpEvent } from '../db/append-imp-event';
import { withImpTransaction } from '../db/with-imp-transaction';
import { openEventStream } from './event-stream';

type StreamOptions = Partial<Parameters<typeof openEventStream>[0]>;

async function setupTest() {
  const database = await createTestDatabase();

  const db = database.db;

  return {
    db,
    open: (options: StreamOptions = {}) =>
      openEventStream({
        changes: db.log.changes,
        readHead: db.log.readHead,
        readAfter: (after) => db.log.readAfter(after, 500),
        readSnapshot: () => Promise.resolve([]),
        present: (event) =>
          readApiEvent(event, () => Promise.reject(new Error('the test logs no imp event'))),
        endsAt: null,
        now: () => Date.UTC(2026, 9, 2, 12),
        ...options,
      }),
  };
}

test('it sends the snapshot, then each event written after the stream opened', async () => {
  const ctx = await setupTest();

  const controller = new AbortController();

  const snapshot = buildMockGovernorDecision({ name: 'snapshot' });

  const stream = ctx.open({
    readSnapshot: () => Promise.resolve([snapshot]),
    signal: controller.signal,
  });

  const first = await stream.next();

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

  const second = await stream.next();

  controller.abort();

  expect(first).toStrictEqual({ done: false, value: snapshot });

  expect(second).toStrictEqual({
    done: false,
    value: {
      // oxlint-disable-next-line id-length -- `v` is the event format's version field
      v: 1,
      at: new Date(Date.UTC(2026, 9, 2, 12)),
      ev: 'GovernorDecision',
      decision: 'admitted',
      name: 'later',
      trigger: 'wake',
      usedMib: 512,
      budgetMib: 4096,
    },
  });
});

test('it sends an event written while the snapshot is read after the snapshot', async () => {
  const ctx = await setupTest();

  const controller = new AbortController();

  const snapshot = buildMockGovernorDecision({ name: 'snapshot' });

  const stream = ctx.open({
    readSnapshot: async () => {
      await ctx.db.log.write(
        {
          ev: 'GovernorDecision',
          decision: 'admitted',
          name: 'during',
          trigger: 'wake',
          usedMib: 512,
          budgetMib: 4096,
        },
        Date.UTC(2026, 9, 2, 12),
      );

      return [snapshot];
    },
    signal: controller.signal,
  });

  const sent = [await stream.next(), await stream.next()];

  controller.abort();

  expect(sent).toMatchObject([
    { done: false, value: { name: 'snapshot' } },
    { done: false, value: { name: 'during' } },
  ]);
});

test('it sends every event to a reader 5,000 events behind', async () => {
  const ctx = await setupTest();

  const controller = new AbortController();

  // the snapshot read comes after the stream holds its cursor, so these events all follow it
  const stream = ctx.open({
    readSnapshot: async () => {
      await withImpTransaction(ctx.db, async (trx) => {
        for (let count = 1; count <= 5000; count += 1) {
          await appendImpEvent(
            trx,
            {
              ev: 'GovernorDecision',
              decision: 'admitted',
              name: `imp-${String(count)}`,
              trigger: 'wake',
              usedMib: 512,
              budgetMib: 4096,
            },
            Date.UTC(2026, 9, 2, 12),
          );
        }
      });

      return [];
    },
    signal: controller.signal,
  });

  const sent: ImpEvent[] = [];

  for (let count = 1; count <= 5000; count += 1) {
    const next = await stream.next();

    invariant(next.done !== true);

    sent.push(next.value);
  }

  controller.abort();

  expect(sent).toStrictEqual(
    Array.from({ length: 5000 }, (_unused, index) => ({
      // oxlint-disable-next-line id-length -- `v` is the event format's version field
      v: 1,
      at: new Date(Date.UTC(2026, 9, 2, 12)),
      ev: 'GovernorDecision',
      decision: 'admitted',
      name: `imp-${String(index + 1)}`,
      trigger: 'wake',
      usedMib: 512,
      budgetMib: 4096,
    })),
  );
});

test('it waits on one change at a time while it reads a backlog of several pages', async () => {
  const ctx = await setupTest();

  const controller = new AbortController();

  const next = mock(ctx.db.log.changes.next);

  const stream = ctx.open({
    changes: { notify: ctx.db.log.changes.notify, next },
    readAfter: (after) => ctx.db.log.readAfter(after, 2),
    readSnapshot: async () => {
      await withImpTransaction(ctx.db, async (trx) => {
        for (let count = 1; count <= 6; count += 1) {
          await appendImpEvent(
            trx,
            {
              ev: 'GovernorDecision',
              decision: 'admitted',
              name: `imp-${String(count)}`,
              trigger: 'wake',
              usedMib: 512,
              budgetMib: 4096,
            },
            Date.UTC(2026, 9, 2, 12),
          );
        }
      });

      return [];
    },
    signal: controller.signal,
  });

  for (let count = 1; count <= 6; count += 1) {
    await stream.next();
  }

  const waiting = stream.next();

  controller.abort();

  await waiting;

  expect(next).toHaveBeenCalledOnce();
});

test('it leaves out the events its reader may not see', async () => {
  const ctx = await setupTest();

  const controller = new AbortController();

  const stream = ctx.open({
    readSnapshot: async () => {
      for (const name of ['hidden', 'shown']) {
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

      return [];
    },
    signal: controller.signal,
    accepts: (event) => event.ev === 'GovernorDecision' && event.name !== 'hidden',
  });

  const first = await stream.next();

  controller.abort();

  expect(first).toMatchObject({ done: false, value: { name: 'shown' } });
});

test('it ends when a prune passes its cursor', async () => {
  const ctx = await setupTest();

  const stream = ctx.open({
    readSnapshot: async () => {
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

      await withImpTransaction(ctx.db, (trx) => pruneEvents(trx, Date.UTC(2026, 9, 20)));

      return [];
    },
  });

  const streamed = await Array.fromAsync(stream);

  expect(streamed).toStrictEqual([]);
});

test('it ends at its abort', async () => {
  const ctx = await setupTest();

  const controller = new AbortController();

  const snapshot = buildMockGovernorDecision();

  const stream = ctx.open({
    readSnapshot: () => Promise.resolve([snapshot]),
    signal: controller.signal,
  });

  const first = await stream.next();

  const waiting = stream.next();

  controller.abort();

  const last = await waiting;

  expect(first).toStrictEqual({ done: false, value: snapshot });
  expect(last).toStrictEqual({ done: true, value: undefined });
});

test('it ends at its end time', async () => {
  const ctx = await setupTest();

  const timers = buildStubClock();

  const stream = ctx.open({
    endsAt: Date.UTC(2026, 9, 2, 12) + 50,
    startTimer: timers.startTimer,
  });

  const waiting = stream.next();
  const pendingMs = timers.readPendingMs();

  timers.firePending();

  const last = await waiting;

  expect(pendingMs).toStrictEqual([50]);
  expect(last).toStrictEqual({ done: true, value: undefined });
  expect(timers.readPendingMs()).toStrictEqual([]);
});

test('it stays open when the longest timer fires short of a 30-day end, and waits out the rest', async () => {
  const ctx = await setupTest();

  const controller = new AbortController();

  const timers = buildStubClock();
  const snapshot = buildMockGovernorDecision();
  const clock = { at: Date.UTC(2026, 9, 2, 12) };

  const stream = ctx.open({
    readSnapshot: () => Promise.resolve([snapshot]),
    signal: controller.signal,
    endsAt: Date.UTC(2026, 9, 2, 12) + 30 * 86_400_000,
    now: () => clock.at,
    startTimer: timers.startTimer,
  });

  const first = await stream.next();

  const clampedMs = timers.readPendingMs();

  clock.at = Date.UTC(2026, 9, 2, 12) + 2 ** 31 - 1;

  timers.firePending();

  await ctx.db.log.write(
    {
      ev: 'GovernorDecision',
      decision: 'admitted',
      name: 'later',
      trigger: 'wake',
      usedMib: 512,
      budgetMib: 4096,
    },
    clock.at,
  );

  const second = await stream.next();

  const pendingMs = timers.readPendingMs();

  controller.abort();

  expect(first).toStrictEqual({ done: false, value: snapshot });

  // setTimeout's longest delay: a longer one would fire at once
  expect(clampedMs).toStrictEqual([2 ** 31 - 1]);
  expect(second).toMatchObject({ done: false, value: { name: 'later' } });

  // 30 days (2_592_000_000 ms) less the longest delay already waited
  expect(pendingMs).toStrictEqual([444_516_353]);
});

test('it ends at a 30-day end once the timer after the longest one fires', async () => {
  const ctx = await setupTest();

  const timers = buildStubClock();
  const snapshot = buildMockGovernorDecision();
  const clock = { at: Date.UTC(2026, 9, 2, 12) };

  const stream = ctx.open({
    readSnapshot: () => Promise.resolve([snapshot]),
    endsAt: Date.UTC(2026, 9, 2, 12) + 30 * 86_400_000,
    now: () => clock.at,
    startTimer: timers.startTimer,
  });

  await stream.next();

  clock.at = Date.UTC(2026, 9, 2, 12) + 2 ** 31 - 1;

  timers.firePending();

  clock.at = Date.UTC(2026, 9, 2, 12) + 30 * 86_400_000;

  timers.firePending();

  const last = await stream.next();

  expect(last).toStrictEqual({ done: true, value: undefined });
  expect(timers.readPendingMs()).toStrictEqual([]);
});
