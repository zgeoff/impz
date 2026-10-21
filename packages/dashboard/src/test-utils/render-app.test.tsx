import { expect, onTestFinished, test } from 'bun:test';
import { renderApp } from './render-app';
import { startDashboardImpd } from './start-dashboard-impd';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dashboardImpd = await startDashboardImpd(stack);

  return { harness: dashboardImpd.harness, logIn: dashboardImpd.logIn };
}

test('it renders the page at the given path under /ui', async () => {
  const ctx = await setupTest();

  await ctx.logIn();

  const rendered = renderApp('/images');

  const heading = await rendered.findByRole('heading', { name: 'Images' });

  expect(heading).toBeInTheDocument();
  expect(rendered.router.state.location.pathname).toBe('/images');
});

test('it renders the imps list when no path is given', async () => {
  const ctx = await setupTest();

  await ctx.logIn();

  const rendered = renderApp();

  const heading = await rendered.findByRole('heading', { name: 'Imps' });

  expect(heading).toBeInTheDocument();
});

test('it answers queries from the impd at the origin of the page', async () => {
  const ctx = await setupTest();

  await ctx.harness.createTestImage('base');
  await ctx.harness.client.imps.create({ name: 'web' });
  await ctx.logIn();

  const rendered = renderApp();

  const row = await rendered.findByRole('row', { name: /web/u });

  expect(row).toBeInTheDocument();
});

test('it opens the login page when the browser holds no session', async () => {
  await setupTest();

  const rendered = renderApp('/images');

  await rendered.findByLabelText('API token');

  expect(rendered.router.state.location.pathname).toBe('/login');
});
