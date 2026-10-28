import { listImps } from '../../src/platform/db/imps';
import { startTestImpd } from '../start-test-impd';
import type { TestImpd, TestImpdOptions } from '../start-test-impd';

export interface TestImpdPoolOptions {
  readonly impd?: Omit<TestImpdOptions, 'onLog'>;
  readonly prepareImpd?: (ctx: TestImpd) => Promise<void>;
}

export interface TestImpdLease {
  readonly ctx: TestImpd;
  readonly retire: () => void;
}

export interface TestImpdCaseOptions {
  readonly onLog?: (message: string, ctx: TestImpd) => void;
}

// a property's cases share one impd, because a boot takes about 60 ms and the reset about 10 ms
export function createTestImpdPool(
  stack: Readonly<AsyncDisposableStack>,
  options: TestImpdPoolOptions = {},
) {
  const sink: { onLog: ((message: string) => void) | undefined } = { onLog: undefined };

  const pool: { current: { ctx: TestImpd; stack: AsyncDisposableStack } | null } = {
    current: null,
  };

  const releaseImpd = async (): Promise<void> => {
    const current = pool.current;

    pool.current = null;

    await current?.stack.disposeAsync();
  };

  stack.defer(releaseImpd);

  const claimImpd = async (): Promise<TestImpd> => {
    if (pool.current !== null) {
      return pool.current.ctx;
    }

    const impdStack = new AsyncDisposableStack();

    pool.current = {
      stack: impdStack,
      ctx: await startTestImpd(impdStack, {
        ...options.impd,
        onLog: (message) => sink.onLog?.(message),
      }),
    };

    await options.prepareImpd?.(pool.current.ctx);

    return pool.current.ctx;
  };

  return {
    withImpd: async <T>(
      run: (lease: TestImpdLease) => Promise<T>,
      caseOptions: TestImpdCaseOptions = {},
    ): Promise<T> => {
      const ctx = await claimImpd();

      const state = { isRetired: false };

      sink.onLog = (message) => caseOptions.onLog?.(message, ctx);

      const outcome = await Promise.try(run, {
        ctx,
        retire: () => {
          state.isRetired = true;
        },
      }).then(
        (value) => ({ isOk: true as const, value }),
        (error: unknown) => ({ isOk: false as const, error }),
      );

      sink.onLog = undefined;

      if (!outcome.isOk) {
        await releaseImpd();

        throw outcome.error;
      }

      if (state.isRetired) {
        await releaseImpd();

        return outcome.value;
      }

      // a reset that fails leaves the impd to no later case
      await resetImpd(ctx).catch(async (error: unknown) => {
        await releaseImpd();

        throw error;
      });

      return outcome.value;
    },
  };
}

async function resetImpd(ctx: TestImpd): Promise<void> {
  ctx.fake.setPace(() => Promise.resolve());
  ctx.fake.clearQueues();
  ctx.fake.releaseHangs();

  await ctx.imps.waitForLifecycle();

  for (const imp of await listImps(ctx.db)) {
    await ctx.client.imps.destroy({ name: imp.name });
  }

  await ctx.imps.waitForLifecycle();

  ctx.rpcFailures.splice(0);
  ctx.logs.splice(0);
}
