import { expect, onTestFinished, test } from 'bun:test';
import { server } from '@impz/test-utils/mock-server';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { IMPD_ORIGIN } from '../test-utils/impd-origin';
import { renderApp } from '../test-utils/render-app';
import { startDashboardImpd } from '../test-utils/start-dashboard-impd';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dashboardImpd = await startDashboardImpd(stack);

  return {
    harness: dashboardImpd.harness,
    client: dashboardImpd.harness.client,
    logIn: dashboardImpd.logIn,
  };
}

test('it stays on the login page with a message for a token impd does not know', async () => {
  const user = userEvent.setup();

  await setupTest();

  const rendered = renderApp('/login');

  const field = await rendered.findByLabelText('API token');

  await user.type(field, 'nope');
  await user.click(rendered.getByRole('button', { name: 'Log in' }));

  const alert = await rendered.findByRole('alert');

  expect(alert).toHaveTextContent('impd knows no such token.');
  expect(rendered.router.state.location.pathname).toBe('/login');
});

test('it opens the imps list for a token impd knows', async () => {
  const user = userEvent.setup();

  const ctx = await setupTest();
  const ci = await ctx.client.tokens.create({ name: 'ci', scope: 'read' });

  const rendered = renderApp('/login');

  const field = await rendered.findByLabelText('API token');

  await user.type(field, ci.secret);
  await user.click(rendered.getByRole('button', { name: 'Log in' }));
  await rendered.findByRole('heading', { name: 'Imps' });

  expect(rendered.router.state.location.pathname).toBe('/');
});

test('it clears what the dashboard knew and opens the login page on log out', async () => {
  const user = userEvent.setup();

  const ctx = await setupTest();

  await ctx.harness.createTestImage('base');
  await ctx.client.imps.create({ name: 'web' });
  await ctx.logIn();

  const rendered = renderApp();

  await rendered.findByRole('row', { name: /web/u });
  await user.click(rendered.getByRole('button', { name: 'Log out' }));
  await rendered.findByLabelText('API token');

  expect(rendered.router.state.location.pathname).toBe('/login');
  expect(rendered.queryClient.getQueryCache().getAll()).toHaveLength(0);
});

test('it says so and stays when the log out fails', async () => {
  const user = userEvent.setup();

  const ctx = await setupTest();

  await ctx.logIn();

  server.use(
    http.post(`${IMPD_ORIGIN}/auth/logout`, () => new HttpResponse(null, { status: 502 })),
  );

  const rendered = renderApp();

  const button = await rendered.findByRole('button', { name: 'Log out' });

  await user.click(button);

  const alert = await rendered.findByRole('alert');

  expect(alert).toHaveTextContent('impd did not log out (HTTP 502)');
  expect(rendered.router.state.location.pathname).toBe('/');
});
