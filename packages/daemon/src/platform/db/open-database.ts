import { Database } from 'bun:sqlite';
import { Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from 'kysely';
import { createEventBus } from '../events/event-bus';
import { createBunSqliteDriver } from './create-bun-sqlite-driver';
import type { ImpWrite, ImpWriteFeed } from './imp-write-feed';
import { runMigrations } from './run-migrations';
import type { DB } from './schema';

export type ImpDatabase = Kysely<DB> & { readonly writes: ImpWriteFeed };

export type ImpQueries = Kysely<DB>;

interface OpenOptions {
  readonly writes?: ImpWriteFeed;
}

export async function openDatabase(path: string, options: OpenOptions = {}): Promise<ImpDatabase> {
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

  const db = Object.assign(builder, { writes: options.writes ?? createEventBus<ImpWrite>() });

  try {
    await runMigrations(db);
  } catch (error) {
    sqlite.close();
    throw error;
  }

  return db;
}
