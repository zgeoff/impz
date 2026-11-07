import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@impz/shared/test-utils/wait-for';
import { buildSQLiteDialect } from '@zgeoff/kysely-bun-sqlite';
import { Kysely } from 'kysely';
import { buildMockNewImage } from '../../test-utils/imps/build-mock-new-image';
import { buildMockNewImp } from '../../test-utils/imps/build-mock-new-imp';
import { createImage } from './images';
import type { LoggedImpEvent } from './imp-log-entry';
import { createImp } from './imps';
import { openDatabase } from './open-database';
import { updateImpState } from './update-imp-state';

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

  await waitFor(() => expect(seen).toHaveLength(1));

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

  await waitFor(() => expect(seen).toHaveLength(2));

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

  await waitFor(() => expect(seen).toHaveLength(1));

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
