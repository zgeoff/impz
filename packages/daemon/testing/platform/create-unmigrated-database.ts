import { Database } from 'bun:sqlite';
import { onTestFinished } from 'bun:test';
import { Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from 'kysely';
import { createBunSqliteDriver } from '../../src/platform/db/create-bun-sqlite-driver';
import type { ImpWrite } from '../../src/platform/db/imp-write-feed';
import type { ImpDatabase } from '../../src/platform/db/open-database';
import type { DB } from '../../src/platform/db/schema';
import { createEventBus } from '../../src/platform/events/event-bus';

// A database opened as openDatabase opens one, with no migration run: a
// test migrates it to the point an older impd left it at. `:memory:` when
// no path is given; closed when the test finishes.
export function createUnmigratedDatabase(path = ':memory:'): ImpDatabase {
  const sqlite = new Database(path, { create: true });

  sqlite.run('PRAGMA journal_mode = WAL;');
  sqlite.run('PRAGMA foreign_keys = ON;');

  const builder = new Kysely<DB>({
    dialect: {
      createAdapter: () => new SqliteAdapter(),
      createDriver: () => createBunSqliteDriver(sqlite),
      createIntrospector: (kysely) => new SqliteIntrospector(kysely),
      createQueryCompiler: () => new SqliteQueryCompiler(),
    },
  });

  const db = Object.assign(builder, { writes: createEventBus<ImpWrite>() });

  // kysely closes a driver only once a query started it, so the handle closes
  // here too
  onTestFinished(async () => {
    await db.destroy();

    sqlite.close();
  });

  return db;
}
