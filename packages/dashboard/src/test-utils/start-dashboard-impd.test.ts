import { expect, onTestFinished, test } from 'bun:test';
import { createImpClient } from '@impz/client';
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

  await fetch(`${IMPD_ORIGIN}/auth/logout`, { method: 'POST' });

  expect(ctx.client.tokens.whoami()).rejects.toMatchObject({ status: 401 });
});

test('it refuses a login with a token impd does not know', async () => {
  const ctx = await setupTest();

  expect(ctx.dashboardImpd.logIn('imp_nobody.secret')).rejects.toThrowWithMessage(
    Error,
    'impd refused the login with 401',
  );
});
