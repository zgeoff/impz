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

  const destroyDriver = builder.destroy.bind(builder);

  // its log never starts: it has no events table until a test runs the migrations; the shared
  // driver's destroy leaves the handle open for its opener to close
  const db = Object.assign(builder, {
    log: createImpEventLog(builder, Date.now),
    sqlite,
    destroy: async () => {
      await destroyDriver();

      sqlite.close();
    },
  });

  onTestFinished(() => db.destroy());

  return db;
}
