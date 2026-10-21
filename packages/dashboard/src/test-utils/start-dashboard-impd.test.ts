import { expect, onTestFinished, test } from 'bun:test';
import { createImpClient } from '@impz/client';
import { readInBackground } from '@impz/daemon/testing';
import { waitFor } from '@impz/test-utils/wait-for';
import { IMPD_ORIGIN } from './impd-origin';
import { startDashboardImpd } from './start-dashboard-impd';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dashboardImpd = await startDashboardImpd(stack);

  return { dashboardImpd, client: createImpClient({ url: IMPD_ORIGIN }) };
}

test('it answers a request to the origin of impd from the real impd', async () => {
  const ctx = await setupTest();

  expect(ctx.client.system.info()).rejects.toMatchObject({ status: 401 });
});

test('it sends the session cookie that impd set back to impd', async () => {
  const ctx = await setupTest();

  await ctx.dashboardImpd.logIn();

  const whoami = await ctx.client.tokens.whoami();

  expect(whoami).toMatchObject({ kind: 'dashboard' });
});

test('it stops sending the session cookie once impd clears it', async () => {
  const ctx = await setupTest();

  await ctx.dashboardImpd.logIn();
  await ctx.client.auth.logout();

  expect(ctx.client.tokens.whoami()).rejects.toMatchObject({ status: 401 });
});

test('it waits until an event stream has started, so an event published after reaches it', async () => {
  const ctx = await setupTest();

  await ctx.dashboardImpd.harness.createTestImage('base');
  await ctx.dashboardImpd.logIn();

  const controller = new AbortController();

  onTestFinished(() => {
    controller.abort();
  });

  const events = await ctx.client.events.stream(undefined, { signal: controller.signal });

  const stream = readInBackground(events);

  await ctx.dashboardImpd.waitForEventStream();
  await ctx.dashboardImpd.harness.client.imps.create({ name: 'web' });

  await waitFor(() => {
    expect(stream.items).toPartiallyContain({ ev: 'ImpAdded', reason: 'created' });
  });
});

test('it refuses a login with a token impd does not know', async () => {
  const ctx = await setupTest();

  expect(ctx.dashboardImpd.logIn('imp_nobody.secret')).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
    status: 401,
  });
});
