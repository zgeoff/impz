import { Database } from 'bun:sqlite';
import { onTestFinished } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSQLiteDialect } from '@zgeoff/kysely-bun-sqlite';
import { Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';
import type { DurableTables } from '../durable-tables';
import { durableMigrations } from '../migrations/durable-migrations';

interface TestDurableDatabase {
  readonly path: string;
  readonly db: Kysely<DurableTables>;
}

// a test process migrates once, and each test writes the template's bytes to a file of its own
const TEMPLATE: { bytes?: Promise<Uint8Array> } = {};

export async function createTestDurableDatabase(): Promise<TestDurableDatabase> {
  TEMPLATE.bytes ??= serializeMigratedDatabase();

  const directory = await mkdtemp(join(tmpdir(), 'durable-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  const path = join(directory, 'durable.db');

  const bytes = await TEMPLATE.bytes;

  await Bun.write(path, bytes);

  const db = openTestConnection(new Database(path));

  onTestFinished(() => db.destroy());

  return { path, db };
}

async function serializeMigratedDatabase(): Promise<Uint8Array> {
  const sqlite = new Database(':memory:');

  const db = openTestConnection(sqlite);

  const migrator = new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve({ ...durableMigrations }) },
  });

  const result = await migrator.migrateToLatest();

  if (result.error !== undefined) {
    throw new Error('the durable migrations failed', { cause: result.error });
  }

  const bytes = sqlite.serialize();

  await db.destroy();

  return bytes;
}

function openTestConnection(sqlite: Database): Kysely<DurableTables> {
  sqlite.run('PRAGMA journal_mode = WAL;');
  sqlite.run('PRAGMA synchronous = OFF;');
  sqlite.run('PRAGMA foreign_keys = ON;');

  const db = new Kysely<DurableTables>({ dialect: buildSQLiteDialect(sqlite) });

  const destroyDriver = db.destroy.bind(db);

  // the shared driver's destroy leaves the handle open for its opener to close
  return Object.assign(db, {
    destroy: async () => {
      await destroyDriver();

      sqlite.close();
    },
  });
}
