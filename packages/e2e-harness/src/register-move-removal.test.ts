import { expect, onTestFinished, test } from 'bun:test';
import { createImpClient } from '@impz/client';
import {
  TEST_TOKEN,
  createMoveHosts,
  createUbuntuImage,
  makeStubDroppedCommit,
} from '@impz/daemon/testing';
import type { MoveHostsOptions } from '@impz/daemon/testing';
import { registerMoveRemoval } from './register-move-removal';

async function setupTest(options: Readonly<MoveHostsOptions> = {}) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const hosts = await createMoveHosts(stack, options);

  const sendSourceRequest = (request: Request) => hosts.source.impd.api.app.handle(request);
  const sendTargetRequest = (request: Request) => hosts.target.impd.api.app.handle(request);

  const clients = {
    source: createImpClient({
      url: 'http://impd.test',
      token: TEST_TOKEN,
      fetch: sendSourceRequest,
    }),
    target: createImpClient({
      url: 'http://impd.test',
      token: TEST_TOKEN,
      fetch: sendTargetRequest,
    }),
  };

  return { hosts, clients };
}

test('it removes the imp from the target when the abort finds the move committed', async () => {
  const ctx = await setupTest({ hook: makeStubDroppedCommit({ drops: 'answer' }) });

  await createUbuntuImage(ctx.hosts.source);
  await createUbuntuImage(ctx.hosts.target);

  await ctx.clients.source.imps.create({ name: 'e2e-x-dev', image: 'ubuntu' });
  await ctx.clients.source.imps.stop({ name: 'e2e-x-dev' });

  const cleanup = new AsyncDisposableStack();

  registerMoveRemoval(cleanup, false, ctx.clients, 'e2e-x-dev');

  const failed = await ctx.hosts.runMove('e2e-x-dev');

  await cleanup.disposeAsync();

  const sourceImps = await ctx.clients.source.imps.list();
  const targetImps = await ctx.clients.target.imps.list();

  expect(failed.error).toContain('dropped the answer');
  expect(sourceImps).toBeEmpty();
  expect(targetImps).toBeEmpty();
});

test('it removes the imp from the target when the removal on the source fails', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.hosts.source);
  await createUbuntuImage(ctx.hosts.target);

  await ctx.clients.source.imps.create({ name: 'e2e-x-dev', image: 'ubuntu' });
  await ctx.clients.source.imps.stop({ name: 'e2e-x-dev' });
  await ctx.hosts.runMove('e2e-x-dev');

  const sendStrangerRequest = (request: Request) => ctx.hosts.source.impd.api.app.handle(request);

  const stranger = createImpClient({
    url: 'http://impd.test',
    token: 'not-a-token',
    fetch: sendStrangerRequest,
  });

  const cleanup = new AsyncDisposableStack();

  registerMoveRemoval(
    cleanup,
    false,
    { source: stranger, target: ctx.clients.target },
    'e2e-x-dev',
  );

  const failure = await cleanup.disposeAsync().then(
    () => null,
    (error: unknown) => error,
  );

  const targetImps = await ctx.clients.target.imps.list();

  expect(failure).toMatchObject({ code: 'UNAUTHORIZED' });
  expect(targetImps).toBeEmpty();
});

test('it keeps the imp with --keep', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.hosts.source);

  await ctx.clients.source.imps.create({ name: 'e2e-x-dev', image: 'ubuntu' });

  const cleanup = new AsyncDisposableStack();

  registerMoveRemoval(cleanup, true, ctx.clients, 'e2e-x-dev');

  await cleanup.disposeAsync();

  const sourceImps = await ctx.clients.source.imps.list();

  expect(sourceImps.map((imp) => imp.name)).toStrictEqual(['e2e-x-dev']);
});
