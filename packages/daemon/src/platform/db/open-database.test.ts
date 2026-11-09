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
import { appendImpEvent } from './append-imp-event';
import { createCheckpoint } from './checkpoints';
import { createImage } from './images';
import type { LoggedImpEvent } from './imp-log-entry';
import { createImp } from './imps';
import { openDatabase } from './open-database';
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

test('it keeps the log ID across opens when only impd wrote the imps', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'imp.sqlite');

  const before = await openDatabase(path);

  ctx.stack.defer(() => before.destroy());

  const image = await createImage(before, buildMockNewImage());
  const imp = await createImp(before, buildMockNewImp({ imageId: image.id }));

  await updateImpState(before, imp.id, { reason: 'stopped', state: 'stopped' });

  const logId = await before.log.readLogId();

  await before.destroy();

  const after = await openDatabase(path);

  ctx.stack.defer(() => after.destroy());

  const reopenedLogId = await after.log.readLogId();

  expect(reopenedLogId).toBe(logId);
});

test.each([
  ['changed an imp', `UPDATE imps SET state = 'stopped'`],
  ['removed an imp', `DELETE FROM imps`],
  ['removed a checkpoint', `DELETE FROM checkpoints`],
])(
  'it gives the log a new ID when an impd that logs no events %s between two opens',
  async (_write, statement) => {
    const ctx = setupTest();
    const path = join(ctx.directory, 'imp.sqlite');

    const before = await openDatabase(path);

    ctx.stack.defer(() => before.destroy());

    const image = await createImage(before, buildMockNewImage());
    const imp = await createImp(before, buildMockNewImp({ imageId: image.id }));

    await createCheckpoint(before, { id: 'cp-calm', impId: imp.id, label: null, sizeBytes: null });

    const logId = await before.log.readLogId();

    await before.destroy();

    const older = new Database(path);

    ctx.stack.defer(() => {
      older.close();
    });

    older.run(statement);
    older.close();

    const after = await openDatabase(path);

    ctx.stack.defer(() => after.destroy());

    const reopenedLogId = await after.log.readLogId();

    expect(reopenedLogId).not.toBeOneOf(['', logId]);
  },
);

test('it keeps the log ID that an impd which logs events but makes no triggers reads after its write', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'imp.sqlite');

  const upgraded = await openDatabase(path);

  ctx.stack.defer(() => upgraded.destroy());

  const image = await createImage(upgraded, buildMockNewImage());

  await createImp(upgraded, buildMockNewImp({ imageId: image.id }));

  const logId = await upgraded.log.readLogId();

  await upgraded.destroy();

  const older = new Database(path);

  ctx.stack.defer(() => {
    older.close();
  });

  older.run(`UPDATE imps SET state = 'stopped'`);

  const seen = older.query('SELECT log_id FROM event_log WHERE id = 1').get();

  expect(seen).toStrictEqual({ log_id: logId });
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
