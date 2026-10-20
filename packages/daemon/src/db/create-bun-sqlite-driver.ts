import type { Database, SQLQueryBindings } from 'bun:sqlite';
import { CompiledQuery } from 'kysely';
import type { DatabaseConnection, Driver, QueryResult } from 'kysely';

// SQLite has one connection, so a promise-chain mutex hands it to one caller
// at a time; every transaction relies on that ordering.
export function createBunSqliteDriver(sqlite: Database) {
  const connection = buildConnection(sqlite);
  let turn: Promise<void> = Promise.resolve();
  let releaseTurn: (() => void) | undefined;

  const acquireConnection = async (): Promise<DatabaseConnection> => {
    const previous = turn;
    let release: (() => void) | undefined;

    turn = new Promise((resolve) => {
      release = resolve;
    });

    await previous;

    if (release !== undefined) {
      releaseTurn = release;
    }

    return connection;
  };

  const releaseConnection = (): Promise<void> => {
    releaseTurn?.();

    return Promise.resolve();
  };

  return {
    init: () => Promise.resolve(),
    acquireConnection,
    beginTransaction: async (held) => {
      await held.executeQuery(CompiledQuery.raw('begin'));
    },
    commitTransaction: async (held) => {
      await held.executeQuery(CompiledQuery.raw('commit'));
    },
    rollbackTransaction: async (held) => {
      await held.executeQuery(CompiledQuery.raw('rollback'));
    },
    releaseConnection,

    // Waits out whatever turn is already queued before closing, so the handle
    // never closes out from under a write still in flight.
    destroy: async () => {
      await acquireConnection();

      sqlite.close();

      await releaseConnection();
    },
  } satisfies Driver;
}

function buildConnection(sqlite: Database): DatabaseConnection {
  return {
    executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
      const stmt = sqlite.query<R, SQLQueryBindings[]>(compiledQuery.sql);

      // oxlint-disable-next-line no-unsafe-type-assertion -- kysely's sqlite compiler only ever binds bun:sqlite-legal values here; this is the one point where it is trusted
      const bindings = compiledQuery.parameters as SQLQueryBindings[];

      if (stmt.columnNames.length > 0) {
        return Promise.resolve({ rows: stmt.all(...bindings) });
      }

      const result = stmt.run(...bindings);

      return Promise.resolve({
        rows: [],
        numAffectedRows: BigInt(result.changes),
        insertId: BigInt(result.lastInsertRowid),
      });
    },

    streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
      throw new Error('the bun:sqlite driver does not support streaming queries');
    },
  };
}
