import { expect, onTestFinished, test } from 'bun:test';
import { createImage, listImages } from '@impz/daemon/host/platform/db/create-image';
import { createImp } from '@impz/daemon/host/platform/db/list-imps';
import { openDatabase } from '@impz/daemon/host/platform/db/open-database';
import { readNames } from '@impz/daemon/host/platform/db/read-names';
import { MIGRATIONS } from '@impz/daemon/host/platform/db/run-migrations';
import { buildMockNewImage } from '@impz/daemon/test-utils/imps/build-mock-new-image';
import { buildMockNewImp } from '@impz/daemon/test-utils/imps/build-mock-new-imp';
import { sql } from 'kysely';
import { openMigratedCopy } from './open-migrated-copy';

test('it opens a copy that has run every migration', async () => {
  const db = await openMigratedCopy();

  onTestFinished(() => db.destroy());

  const executed = await sql`
    SELECT name FROM kysely_migration ORDER BY name
  `.execute(db);

  expect(readNames(executed.rows)).toStrictEqual(Object.keys(MIGRATIONS).toSorted());
});

test('it opens a copy with the schema of a database migrated on open', async () => {
  const copy = await openMigratedCopy();

  onTestFinished(() => copy.destroy());

  const fresh = await openDatabase(':memory:');

  onTestFinished(() => fresh.destroy());

  const readSchema = sql`
    SELECT type, name, sql FROM sqlite_master ORDER BY type, name
  `;

  const copySchema = await readSchema.execute(copy);
  const freshSchema = await readSchema.execute(fresh);

  expect(copySchema.rows).toStrictEqual(freshSchema.rows);
});

test('it refuses an imp whose image does not exist', async () => {
  const db = await openMigratedCopy();

  onTestFinished(() => db.destroy());

  expect(createImp(db, buildMockNewImp({ imageId: 'img_missing' }))).rejects.toThrow(
    'FOREIGN KEY constraint failed',
  );
});

test('it opens an independent copy on each call', async () => {
  const first = await openMigratedCopy();

  onTestFinished(() => first.destroy());

  const second = await openMigratedCopy();

  onTestFinished(() => second.destroy());

  await createImage(first, buildMockNewImage({ name: 'dev' }));

  expect(listImages(second)).resolves.toStrictEqual([]);
});

test('it lets a copy grow past the size of the template', async () => {
  const db = await openMigratedCopy();

  onTestFinished(() => db.destroy());

  await sql`
    CREATE TABLE growth AS
    WITH RECURSIVE counter(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM counter WHERE value < 5000)
    SELECT value, randomblob(200) AS payload FROM counter
  `.execute(db);

  const counted = await sql`SELECT count(*) AS rows FROM growth`.execute(db);

  expect(counted.rows).toStrictEqual([{ rows: 5000 }]);
});
