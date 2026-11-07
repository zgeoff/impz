import { Database } from 'bun:sqlite';
import { onTestFinished } from 'bun:test';
import { buildSQLiteDialect } from '@zgeoff/kysely-bun-sqlite';
import { Kysely } from 'kysely';
import { createImpEventLog } from '../../platform/db/create-imp-event-log';
import type { ImpDatabase } from '../../platform/db/open-database';
import type { DB } from '../../platform/db/schema';

export function createUnmigratedDatabase(path = ':memory:'): ImpDatabase {
  const sqlite = new Database(path, { create: true });

  sqlite.run('PRAGMA journal_mode = WAL;');
  sqlite.run('PRAGMA foreign_keys = ON;');

  const builder = new Kysely<DB>({ dialect: buildSQLiteDialect(sqlite) });

  // its log never starts: it has no events table until a test runs the migrations
  const db = Object.assign(builder, { log: createImpEventLog(builder) });

  // the shared driver's destroy leaves the handle open for its opener to close
  onTestFinished(async () => {
    await db.destroy();

    sqlite.close();
  });

  return db;
}
