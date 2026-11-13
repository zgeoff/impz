import { Database } from 'bun:sqlite';
import {
  createOutsideWriteTriggers,
  removeLogIDAfterOutsideWrites,
  writeNewLogID,
} from '@impz/durable';
import { buildSQLiteDialect } from '@zgeoff/kysely-bun-sqlite';
import { Kysely } from 'kysely';
import { createImpEventLog } from './create-imp-event-log';
import type { ImpEventLog } from './create-imp-event-log';
import { runMigrations } from './run-migrations';
import type { DB } from './schema';

// sqlite: the handle under the builder. Give a library the builder, not the handle: a second Kysely
// over the handle keeps a lock of its own, so its writes join an open impd transaction and roll
// back with it.
export type ImpDatabase = Kysely<DB> & { readonly log: ImpEventLog; readonly sqlite: Database };

export type ImpQueries = Kysely<DB>;

const LOGGED_TABLES = ['imps', 'checkpoints'] as const satisfies readonly (keyof DB)[];

export async function openDatabase(
  source: string | Database,
  now: () => number = Date.now,
): Promise<ImpDatabase> {
  const sqlite = typeof source === 'string' ? new Database(source, { create: true }) : source;

  sqlite.run('PRAGMA journal_mode = WAL;');
  sqlite.run('PRAGMA foreign_keys = ON;');

  const builder = new Kysely<DB>({ dialect: buildSQLiteDialect(sqlite) });

  const destroyDriver = builder.destroy.bind(builder);
  const log = createImpEventLog(builder, now);

  // the shared driver's destroy leaves the handle open for its opener to close
  const db = Object.assign(builder, {
    log,
    sqlite,
    destroy: async () => {
      await log.stop();

      await destroyDriver();

      sqlite.close();
    },
  });

  try {
    await runMigrations(db);
    await createOutsideWriteTriggers(db, LOGGED_TABLES);
    await removeLogIDAfterOutsideWrites(db);
    await writeNewLogID(db);

    await log.start();
  } catch (error) {
    sqlite.close();
    throw error;
  }

  return db;
}
