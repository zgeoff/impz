import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSQLiteDialect } from '@zgeoff/kysely-bun-sqlite';
import { Kysely } from 'kysely';
import { buildMockNewImage } from '../../../testing/imps/build-mock-new-image';
import { buildMockNewImp } from '../../../testing/imps/build-mock-new-imp';
import { createEventBus } from '../events/event-bus';
import { createImage } from './images';
import type { ImpWrite } from './imp-write-feed';
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

test('it publishes each imp write on the feed it was given', async () => {
  const writes = createEventBus<ImpWrite>();
  const seen: ImpWrite[] = [];

  writes.subscribe((write) => {
    seen.push(write);
  });

  const db = await openDatabase(':memory:', { writes });

  onTestFinished(() => db.destroy());

  const image = await createImage(db, buildMockNewImage());
  const imp = await createImp(db, buildMockNewImp({ imageId: image.id }));

  expect(seen).toStrictEqual([{ kind: 'added', imp }]);
});

test('it commits an imp write whose feed has a listener that throws, and tells the rest', async () => {
  const writes = createEventBus<ImpWrite>();
  const seen: ImpWrite[] = [];

  writes.subscribe(() => {
    throw new Error('the listener broke');
  });

  writes.subscribe((write) => {
    seen.push(write);
  });

  const db = await openDatabase(':memory:', { writes });

  onTestFinished(() => db.destroy());

  const image = await createImage(db, buildMockNewImage());
  const imp = await createImp(db, buildMockNewImp({ imageId: image.id }));
  const stopped = await updateImpState(db, imp.id, { reason: 'stopped', state: 'stopped' });

  expect(seen).toStrictEqual([
    { kind: 'added', imp },
    { kind: 'changed', imp: stopped, reason: 'stopped' },
  ]);
});

test('it gives each database a feed of its own when none is given', async () => {
  const first = await openDatabase(':memory:');

  onTestFinished(() => first.destroy());

  const second = await openDatabase(':memory:');

  onTestFinished(() => second.destroy());

  const seen: ImpWrite[] = [];

  second.writes.subscribe((write) => {
    seen.push(write);
  });

  const image = await createImage(first, buildMockNewImage());

  await createImp(first, buildMockNewImp({ imageId: image.id }));

  expect(seen).toStrictEqual([]);
});
