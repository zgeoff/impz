import { onTestFinished } from 'bun:test';
import { hookSQLiteStatements } from '@zgeoff/mcp-auth/testing';
import { sql } from 'kysely';
import type { KyselyPlugin } from 'kysely';
import type { ImpDatabase } from '../../platform/db/open-database';

// An impd transaction that begins, waits as one that awaits I/O does, then rolls back. The code
// under test gets `db`. rollBack first waits until that code tries a statement on the connection:
// a write that reaches sqlite, or a query that `db` compiles before it waits for the driver.
export function buildHeldTransaction(source: ImpDatabase) {
  const tried = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const state = { isOpen: false, ended: Promise.resolve<unknown>(null) };

  onTestFinished(() => {
    released.resolve();
  });

  const signalTry = () => {
    if (state.isOpen) {
      tried.resolve();
    }
  };

  hookSQLiteStatements(source.sqlite, (statement) => {
    if (/^\s*(?:insert|update|delete)\b/iu.test(statement)) {
      signalTry();
    }
  });

  const plugin: KyselyPlugin = {
    transformQuery: (args) => {
      signalTry();

      return args.node;
    },
    transformResult: (args) => Promise.resolve(args.result),
  };

  return {
    db: Object.assign(source.withPlugin(plugin), { log: source.log, sqlite: source.sqlite }),
    open: async () => {
      const begun = Promise.withResolvers<void>();

      const ended = source.transaction().execute(async (trx) => {
        await sql`SELECT 1`.execute(trx);

        begun.resolve();

        await released.promise;

        throw new Error('the held transaction rolls back');
      });

      state.ended = Promise.allSettled([ended]);

      await Promise.race([begun.promise, ended]);

      state.isOpen = true;
    },
    rollBack: async () => {
      await tried.promise;

      released.resolve();

      await state.ended;
    },
  };
}
