import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneEvents } from '@impz/durable';
import { waitFor } from '@impz/shared/test-utils/wait-for';
import { buildSQLiteDialect } from '@zgeoff/kysely-bun-sqlite';
import { Kysely, sql } from 'kysely';
import { buildMockNewImage } from '../../test-utils/imps/build-mock-new-image';
import { buildMockNewImp } from '../../test-utils/imps/build-mock-new-imp';
import { captureImpdLogs } from '../../test-utils/platform/capture-impd-logs';
import { createUnmigratedDatabase } from '../../test-utils/platform/create-unmigrated-database';
import { appendImpEvent } from './append-imp-event';
import { createCheckpoint, removeCheckpoint } from './checkpoints';
import { createImage } from './images';
import type { LoggedImpEvent } from './imp-log-entry';
import { createImp, removeImp, updateImpActivity } from './imps';
import { openDatabase } from './open-database';
import type { ImpDatabase } from './open-database';
import { updateImpState } from './update-imp-state';
import { withImpTransaction } from './with-imp-transaction';

function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const directory = mkdtempSync(join(tmpdir(), 'imp-open-database-'));

  stack.defer(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directory, stack };
}

test('it closes the database file when the database is destroyed', async () => {
  const ctx = setupTest();

  const db = await openDatabase(join(ctx.directory, 'imp.sqlite'));

  ctx.stack.defer(() => db.destroy());

  await createImage(db, buildMockNewImage());

  await db.destroy();

  // sqlite removes the WAL and shared-memory files only when the last handle on the file closes
  expect(readdirSync(ctx.directory)).toStrictEqual(['imp.sqlite']);
});

test("it leaves the handle open when the shared dialect's driver is destroyed", async () => {
  const sqlite = new Database(':memory:');

  onTestFinished(() => {
    sqlite.close();
  });

  const builder = new Kysely<Record<string, never>>({ dialect: buildSQLiteDialect(sqlite) });

  await builder.selectNoFrom((expressionBuilder) => expressionBuilder.lit(1).as('one')).execute();
  await builder.destroy();

  expect(sqlite.query('select 1 as one').get()).toStrictEqual({ one: 1 });
});

test("it tells impd's own followers each imp write once it commits", async () => {
  const db = await openDatabase(':memory:');

  onTestFinished(() => db.destroy());

  const seen: LoggedImpEvent[] = [];

  onTestFinished(
    db.log.subscribe((event) => {
      seen.push(event);
    }),
  );

  const image = await createImage(db, buildMockNewImage());
  const imp = await createImp(db, buildMockNewImp({ imageId: image.id }));

  await waitFor(() => {
    expect(seen).toHaveLength(1);
  });

  expect(seen).toStrictEqual([{ ev: 'ImpAdded', imp, seq: 1, at: expect.any(Date) }]);
});

test('it tells the other followers when one of them throws', async () => {
  const db = await openDatabase(':memory:');

  onTestFinished(() => db.destroy());

  const seen: LoggedImpEvent[] = [];

  onTestFinished(
    db.log.subscribe(() => {
      throw new Error('the listener broke');
    }),
  );

  onTestFinished(
    db.log.subscribe((event) => {
      seen.push(event);
    }),
  );

  const image = await createImage(db, buildMockNewImage());
  const imp = await createImp(db, buildMockNewImp({ imageId: image.id }));
  const stopped = await updateImpState(db, imp.id, { reason: 'stopped', state: 'stopped' });

  await waitFor(() => {
    expect(seen).toHaveLength(2);
  });

  expect(seen).toStrictEqual([
    { ev: 'ImpAdded', imp, seq: 1, at: expect.any(Date) },
    { ev: 'ImpChanged', imp: stopped, reason: 'stopped', seq: 2, at: expect.any(Date) },
  ]);
});

test('it gives each database a log of its own', async () => {
  const first = await openDatabase(':memory:');

  onTestFinished(() => first.destroy());

  const second = await openDatabase(':memory:');

  onTestFinished(() => second.destroy());

  const firstImage = await createImage(first, buildMockNewImage());
  const secondImage = await createImage(second, buildMockNewImage());

  const seen: LoggedImpEvent[] = [];

  onTestFinished(
    second.log.subscribe((event) => {
      seen.push(event);
    }),
  );

  await createImp(first, buildMockNewImp({ name: 'calm-finch', imageId: firstImage.id }));

  const imp = await createImp(
    second,
    buildMockNewImp({ name: 'bold-wren', imageId: secondImage.id }),
  );

  await waitFor(() => {
    expect(seen).toHaveLength(1);
  });

  expect(seen).toStrictEqual([{ ev: 'ImpAdded', imp, seq: 1, at: expect.any(Date) }]);
});

test('it keeps the event of a committed write when impd stops right after the commit', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'imp.sqlite');

  const before = await openDatabase(path);
  const image = await createImage(before, buildMockNewImage());
  const imp = await createImp(before, buildMockNewImp({ imageId: image.id }));

  await before.destroy();

  const after = await openDatabase(path);

  ctx.stack.defer(() => after.destroy());

  const read = await after.log.readAfter(0, 10);

  expect(read).toStrictEqual({
    kind: 'events',
    events: [{ ev: 'ImpAdded', imp, seq: 1, at: expect.any(Date) }],
    throughSeq: 1,
    hasMore: false,
  });
});

test('it gives the log one new ID after another impd wrote, and keeps it after impd writes', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'imp.sqlite');

  const first = await openDatabase(path);

  ctx.stack.defer(() => first.destroy());

  const image = await createImage(first, buildMockNewImage());
  const imp = await createImp(first, buildMockNewImp({ imageId: image.id }));
  const firstLogID = await first.log.readLogID();

  await first.destroy();

  const older = createUnmigratedDatabase(path);

  ctx.stack.defer(() => older.destroy());

  await updateImpActivity(older, imp.id, new Date(Date.UTC(2026, 9, 1)));

  await older.destroy();

  const second = await openDatabase(path);

  ctx.stack.defer(() => second.destroy());

  await updateImpState(second, imp.id, { reason: 'stopped', state: 'stopped' });

  const secondLogID = await second.log.readLogID();

  await second.destroy();

  const third = await openDatabase(path);

  ctx.stack.defer(() => third.destroy());

  const thirdLogID = await third.log.readLogID();

  expect({ isRotated: secondLogID !== firstLogID, thirdLogID }).toStrictEqual({
    isRotated: true,
    thirdLogID: secondLogID,
  });
});

test.each([
  [
    'changed an imp',
    (older: ImpDatabase, impID: string) =>
      updateImpActivity(older, impID, new Date(Date.UTC(2026, 9, 1))),
  ],
  ['removed an imp', (older: ImpDatabase, impID: string) => removeImp(older, impID)],
  ['removed a checkpoint', (older: ImpDatabase) => removeCheckpoint(older, 'cp-calm')],
])(
  'it gives the log a new ID when another impd %s between two opens',
  async (_write, writeAsOlderImpd) => {
    const ctx = setupTest();
    const path = join(ctx.directory, 'imp.sqlite');

    const before = await openDatabase(path);

    ctx.stack.defer(() => before.destroy());

    const image = await createImage(before, buildMockNewImage());
    const imp = await createImp(before, buildMockNewImp({ imageId: image.id }));

    await createCheckpoint(before, { id: 'cp-calm', impId: imp.id, label: null, sizeBytes: null });

    const logID = await before.log.readLogID();

    await before.destroy();

    const older = createUnmigratedDatabase(path);

    ctx.stack.defer(() => older.destroy());

    await writeAsOlderImpd(older, imp.id);

    await older.destroy();

    const after = await openDatabase(path);

    ctx.stack.defer(() => after.destroy());

    const reopenedLogID = await after.log.readLogID();

    expect(reopenedLogID).not.toBeOneOf(['', logID]);
  },
);

test('it keeps the log ID that an impd which logs events but makes no triggers reads after its write', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'imp.sqlite');

  const upgraded = await openDatabase(path);

  ctx.stack.defer(() => upgraded.destroy());

  const image = await createImage(upgraded, buildMockNewImage());
  const imp = await createImp(upgraded, buildMockNewImp({ imageId: image.id }));
  const logID = await upgraded.log.readLogID();

  await upgraded.destroy();

  const older = createUnmigratedDatabase(path);

  ctx.stack.defer(() => older.destroy());

  await updateImpState(older, imp.id, { reason: 'stopped', state: 'stopped' });

  const seenLogID = await older.log.readLogID();

  expect(seenLogID).toBe(logID);
});

test('it stamps each event with the clock it was opened with', async () => {
  const db = await openDatabase(':memory:', () => 1_800_000_000_000);

  onTestFinished(() => db.destroy());

  const image = await createImage(db, buildMockNewImage());

  await createImp(db, buildMockNewImp({ imageId: image.id }));

  const read = await db.log.readAfter(0, 10);

  expect(read).toStrictEqual({
    kind: 'events',
    events: [expect.objectContaining({ at: new Date(1_800_000_000_000) })],
    throughSeq: 1,
    hasMore: false,
  });
});

test("it tells impd's own followers every event of a burst longer than one read", async () => {
  const db = await openDatabase(':memory:');

  onTestFinished(() => db.destroy());

  const seen: LoggedImpEvent[] = [];

  onTestFinished(
    db.log.subscribe((event) => {
      seen.push(event);
    }),
  );

  await withImpTransaction(db, async (trx, at) => {
    for (let count = 1; count <= 600; count += 1) {
      await appendImpEvent(
        trx,
        {
          ev: 'GovernorDecision',
          decision: 'admitted',
          name: 'busy-imp',
          trigger: 'wake',
          usedMib: 512,
          budgetMib: 4096,
        },
        at,
      );
    }
  });

  await waitFor(() => {
    expect(seen).toHaveLength(600);
  });

  expect(seen.map((event) => event.seq)).toStrictEqual(
    Array.from({ length: 600 }, (_unused, index) => index + 1),
  );
});

test("it moves impd's own followers past events a prune removed before they read them", async () => {
  const db = await openDatabase(':memory:', () => Date.UTC(2026, 9, 2));

  onTestFinished(() => db.destroy());

  const lines = captureImpdLogs();
  const seen: LoggedImpEvent[] = [];

  onTestFinished(
    db.log.subscribe((event) => {
      seen.push(event);
    }),
  );

  await withImpTransaction(db, async (trx) => {
    await appendImpEvent(
      trx,
      {
        ev: 'GovernorDecision',
        decision: 'admitted',
        name: 'pruned-imp',
        trigger: 'wake',
        usedMib: 512,
        budgetMib: 4096,
      },
      Date.UTC(2026, 8, 1),
    );

    await pruneEvents(trx, Date.UTC(2026, 9, 2));
  });

  await db.log.write(
    {
      ev: 'GovernorDecision',
      decision: 'admitted',
      name: 'kept-imp',
      trigger: 'wake',
      usedMib: 512,
      budgetMib: 4096,
    },
    Date.UTC(2026, 9, 2),
  );

  await waitFor(() => {
    expect(seen).toHaveLength(1);
  });

  expect(seen).toStrictEqual([expect.objectContaining({ name: 'kept-imp', seq: 2 })]);

  expect(lines).toSatisfyAny((line: string) =>
    line.includes("a prune passed impd's own followers"),
  );
});

test("it keeps impd's own followers going after a read of the log fails", async () => {
  const db = await openDatabase(':memory:');

  onTestFinished(() => db.destroy());

  const lines = captureImpdLogs();
  const seen: LoggedImpEvent[] = [];

  onTestFinished(
    db.log.subscribe((event) => {
      seen.push(event);
    }),
  );

  await sql`ALTER TABLE events RENAME TO events_away`.execute(db);

  db.log.changes.notify();

  await waitFor(() => {
    expect(lines).toSatisfyAny((line: string) => line.includes('failed to read the log'));
  });

  await sql`ALTER TABLE events_away RENAME TO events`.execute(db);

  await db.log.write(
    {
      ev: 'GovernorDecision',
      decision: 'admitted',
      name: 'after-imp',
      trigger: 'wake',
      usedMib: 512,
      budgetMib: 4096,
    },
    1_800_000_000_000,
  );

  await waitFor(() => {
    expect(seen).toHaveLength(1);
  });

  expect(seen).toStrictEqual([expect.objectContaining({ name: 'after-imp', seq: 1 })]);
});
