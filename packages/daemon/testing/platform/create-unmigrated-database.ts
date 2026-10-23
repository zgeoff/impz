import { Database } from 'bun:sqlite';
import { onTestFinished } from 'bun:test';
import { buildSQLiteDialect } from '@zgeoff/kysely-bun-sqlite';
import { Kysely } from 'kysely';
import type { ImpWrite } from '../../src/platform/db/imp-write-feed';
import type { ImpDatabase } from '../../src/platform/db/open-database';
import type { DB } from '../../src/platform/db/schema';
import { createEventBus } from '../../src/platform/events/event-bus';

export function createUnmigratedDatabase(path = ':memory:'): ImpDatabase {
  const sqlite = new Database(path, { create: true });

  sqlite.run('PRAGMA journal_mode = WAL;');
  sqlite.run('PRAGMA foreign_keys = ON;');

  const builder = new Kysely<DB>({ dialect: buildSQLiteDialect(sqlite) });

  const db = Object.assign(builder, { writes: createEventBus<ImpWrite>() });

  // the shared driver's destroy leaves the handle open for its opener to close
  onTestFinished(async () => {
    await db.destroy();

    sqlite.close();
  });

  return db;
}
