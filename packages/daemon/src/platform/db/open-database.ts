import { Database } from 'bun:sqlite';
import { buildSQLiteDialect } from '@zgeoff/kysely-bun-sqlite';
import { Kysely } from 'kysely';
import { createEventBus } from '../events/event-bus';
import type { ImpWrite, ImpWriteFeed } from './imp-write-feed';
import { runMigrations } from './run-migrations';
import type { DB } from './schema';

export type ImpDatabase = Kysely<DB> & { readonly writes: ImpWriteFeed };

export type ImpQueries = Kysely<DB>;

interface OpenOptions {
  readonly writes?: ImpWriteFeed;
}

export async function openDatabase(
  source: string | Database,
  options: OpenOptions = {},
): Promise<ImpDatabase> {
  const sqlite = typeof source === 'string' ? new Database(source, { create: true }) : source;

  sqlite.run('PRAGMA journal_mode = WAL;');
  sqlite.run('PRAGMA foreign_keys = ON;');

  const builder = new Kysely<DB>({ dialect: buildSQLiteDialect(sqlite) });

  const destroyDriver = builder.destroy.bind(builder);

  // the shared driver's destroy leaves the handle open for its opener to close
  const db = Object.assign(builder, {
    writes: options.writes ?? createEventBus<ImpWrite>(),
    destroy: async () => {
      await destroyDriver();

      sqlite.close();
    },
  });

  try {
    await runMigrations(db);
  } catch (error) {
    sqlite.close();
    throw error;
  }

  return db;
}
