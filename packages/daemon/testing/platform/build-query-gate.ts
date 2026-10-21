import { onTestFinished } from 'bun:test';
import type { KyselyPlugin } from 'kysely';
import type { ImpDatabase } from '../../src/platform/db/open-database';

export function buildQueryGate(name: string) {
  const state = { armed: false, name, held: new Set<unknown>() };
  const reached = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();

  onTestFinished(() => {
    released.resolve();
  });

  const plugin: KyselyPlugin = {
    transformQuery: (args) => {
      const isNamed =
        args.node.kind === 'SelectQueryNode' &&
        JSON.stringify(args.node).includes(`"${state.name}"`);

      if (state.armed && isNamed) {
        state.armed = false;

        state.held.add(args.queryId);
      }

      return args.node;
    },
    transformResult: async (args) => {
      if (state.held.has(args.queryId)) {
        reached.resolve();

        await released.promise;
      }

      return args.result;
    },
  };

  return {
    plugin,

    wrap: (db: ImpDatabase): ImpDatabase =>
      Object.assign(db.withPlugin(plugin), { writes: db.writes }),
    arm: (armedName: string = name) => {
      state.name = armedName;
      state.armed = true;
    },
    reached: reached.promise,
    release: () => {
      released.resolve();
    },
  };
}
