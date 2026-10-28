import { expect, mock, onTestFinished, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { buildStubAnswerQueue } from '@impz/test-utils/build-stub-answer-queue';
import invariant from 'tiny-invariant';
import type { Impd } from '../../src/create-impd';
import { listImps } from '../../src/platform/db/imps';
import type { TestImpd } from '../start-test-impd';
import { createTestImpdPool } from './create-test-impd-pool';

function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  return { stack };
}

test('it gives the next case the impd that the last case left usable', async () => {
  const ctx = setupTest();
  const pool = createTestImpdPool(ctx.stack);

  const first = await pool.withImpd((lease) => Promise.resolve(lease.ctx.impd));
  const second = await pool.withImpd((lease) => Promise.resolve(lease.ctx.impd));

  expect(second).toBe(first);
});

test('it removes the imps that a case leaves before the next case', async () => {
  const ctx = setupTest();

  const pool = createTestImpdPool(ctx.stack, {
    prepareImpd: async (impd) => {
      await impd.createTestImage('ubuntu');
    },
  });

  await pool.withImpd(async (lease) => {
    await lease.ctx.client.imps.create({ name: 'a' });
    await lease.ctx.client.imps.create({ name: 'b' });
  });

  const imps = await pool.withImpd((lease) => listImps(lease.ctx.db));

  expect(imps).toStrictEqual([]);
});

test('it frees the names that a case used for the next case', async () => {
  const ctx = setupTest();

  const pool = createTestImpdPool(ctx.stack, {
    prepareImpd: async (impd) => {
      await impd.createTestImage('ubuntu');
    },
  });

  await pool.withImpd(async (lease) => {
    await lease.ctx.client.imps.create({ name: 'a' });
    await lease.ctx.client.checkpoints.create({ name: 'a', label: 'base' });
  });

  const imp = await pool.withImpd((lease) => lease.ctx.client.imps.create({ name: 'a' }));

  expect(imp).toMatchObject({ name: 'a', state: 'running' });
});

test('it boots a fresh impd after a case that retires its impd', async () => {
  const ctx = setupTest();
  const pool = createTestImpdPool(ctx.stack);

  const first = await pool.withImpd((lease) => {
    lease.retire();

    return Promise.resolve(lease.ctx.impd);
  });

  const second = await pool.withImpd((lease) => Promise.resolve(lease.ctx.impd));

  expect(second).not.toBe(first);
});

test('it boots a fresh impd after a case that fails', async () => {
  const ctx = setupTest();
  const pool = createTestImpdPool(ctx.stack);
  const seen: Impd[] = [];

  const failed = await pool
    .withImpd((lease) => {
      seen.push(lease.ctx.impd);
      throw new Error('the case failed');
    })
    .then(
      () => null,
      (error: unknown) => error,
    );

  const second = await pool.withImpd((lease) => Promise.resolve(lease.ctx.impd));

  expect(failed).toStrictEqual(new Error('the case failed'));
  expect(seen).not.toContain(second);
});

test('it fails the case and boots a fresh impd when the reset fails', async () => {
  const ctx = setupTest();

  const pool = createTestImpdPool(ctx.stack, {
    impd: {
      boundaries: {
        taps: {
          setupTap: () => Promise.resolve(),
          removeTap: () => Promise.reject(new Error('the tap is busy')),
        },
      },
    },
    prepareImpd: async (impd) => {
      await impd.createTestImage('ubuntu');
    },
  });

  const seen: Impd[] = [];

  const failed = await pool
    .withImpd(async (lease) => {
      seen.push(lease.ctx.impd);

      await lease.ctx.client.imps.create({ name: 'a' });
    })
    .then(
      () => null,
      (error: unknown) => error,
    );

  const second = await pool.withImpd((lease) => Promise.resolve(lease.ctx.impd));

  expect(failed).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  expect(seen).not.toContain(second);
});

test('it releases an impd whose prepare fails and boots a fresh one for the next case', async () => {
  const ctx = setupTest();
  const prepared: TestImpd[] = [];

  const answers = buildStubAnswerQueue([
    () => Promise.reject(new Error('the image write failed')),
    () => Promise.resolve(),
  ]);

  const pool = createTestImpdPool(ctx.stack, {
    prepareImpd: (impd) => {
      prepared.push(impd);

      return answers.next()();
    },
  });

  const firstCase = pool.withImpd(() => Promise.resolve());

  const failed = await firstCase.then(
    () => null,
    (error: unknown) => error,
  );

  const second = await pool.withImpd((lease) => Promise.resolve(lease.ctx.impd));

  const [first, retried] = prepared;

  invariant(first !== undefined && retried !== undefined);

  expect(failed).toStrictEqual(new Error('the image write failed'));
  expect(second).toBe(retried.impd);
  expect(existsSync(first.dataDir)).toBeFalse();
});

test('it prepares each impd it boots once', async () => {
  const ctx = setupTest();
  const prepareImpd = mock(() => Promise.resolve());
  const pool = createTestImpdPool(ctx.stack, { prepareImpd });

  await pool.withImpd(() => Promise.resolve());
  await pool.withImpd(() => Promise.resolve());

  await pool.withImpd((lease) => {
    lease.retire();

    return Promise.resolve();
  });

  await pool.withImpd(() => Promise.resolve());

  expect(prepareImpd).toHaveBeenCalledTimes(2);
});

test("it passes impd's log lines only to the case that runs", async () => {
  const ctx = setupTest();
  const first = mock<(message: string, impd: TestImpd) => void>();
  const second = mock<(message: string, impd: TestImpd) => void>();
  const pool = createTestImpdPool(ctx.stack);

  await pool.withImpd(() => Promise.resolve(), { onLog: first });

  await pool.withImpd(
    (lease) => {
      lease.ctx.logRpcFailure(new Error('the call failed'));

      return Promise.resolve();
    },
    { onLog: second },
  );

  expect(first).not.toHaveBeenCalled();

  expect(second).toHaveBeenCalledWith(
    expect.toStartWith('ERROR impd.api rpc failed: '),
    expect.anything(),
  );
});

test('it clears the RPC failures that a case leaves', async () => {
  const ctx = setupTest();
  const pool = createTestImpdPool(ctx.stack);

  await pool.withImpd((lease) => {
    lease.ctx.logRpcFailure(new Error('the call failed'));

    return Promise.resolve();
  });

  const failures = await pool.withImpd((lease) => Promise.resolve([...lease.ctx.rpcFailures]));

  expect(failures).toStrictEqual([]);
});
