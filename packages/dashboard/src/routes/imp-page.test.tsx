import { expect, mock, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { buildImpPaths } from '@impz/daemon/testing';
import { server } from '@impz/test-utils/mock-server';
import { waitFor } from '@impz/test-utils/wait-for';
import { within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

test('it shows the RAM and disk use of the imp', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  // the disk use comes from FIEMAP, which a tmpfs lacks
  const dataDir = await mkdtemp('/var/tmp/dashboard-imp-');

  onTestFinished(() => rm(dataDir, { recursive: true, force: true }));

  const dashboardImpd = await startDashboardImpd(stack, { dataDir });

  const harness = dashboardImpd.harness;

  await harness.createTestImage('base');
  await harness.client.imps.create({ name: 'web', diskMib: 32_768 });
  await harness.tickers.fire('disk-usage');
  await dashboardImpd.logIn();

  const rendered = renderApp('/imps/web');

  await rendered.findByRole('heading', { name: 'web' });

  expect(rendered.getByText('300 MiB owned, 340 MiB resident')).toBeInTheDocument();
  expect(rendered.getByText('4.0 KiB / 32.0 GiB, 0 B shared')).toBeInTheDocument();
});

test('it lists the checkpoints of the imp', async () => {
  const ctx = await setupTest();

  await ctx.harness.createTestImage('base');
  await ctx.client.imps.create({ name: 'web' });
  await ctx.client.checkpoints.create({ name: 'web', label: 'before-upgrade' });
  await ctx.logIn();

  const rendered = renderApp('/imps/web');

  const row = await rendered.findByRole('row', { name: /before-upgrade/u });

  expect(row).toBeInTheDocument();
});

test('it takes a checkpoint with a label', async () => {
  const user = userEvent.setup();

  const ctx = await setupTest();

  await ctx.harness.createTestImage('base');
  await ctx.client.imps.create({ name: 'web' });
  await ctx.logIn();

  const rendered = renderApp('/imps/web');

  const field = await rendered.findByLabelText('Label');

  await user.type(field, 'v2');
  await user.click(rendered.getByRole('button', { name: 'Checkpoint now' }));
  await rendered.findByRole('row', { name: /v2/u });

  const checkpoints = await ctx.client.checkpoints.list({ name: 'web' });

  expect(checkpoints.map((checkpoint) => checkpoint.label)).toStrictEqual(['v2']);
});

test('it restores the named checkpoint after a confirm', async () => {
  const user = userEvent.setup();

  const ctx = await setupTest();

  await ctx.harness.createTestImage('base');

  const imp = await ctx.client.imps.create({ name: 'web' });

  const disk = buildImpPaths(ctx.harness.dataDir, imp.id).disk;

  await Bun.write(disk, 'before the upgrade');
  await ctx.client.checkpoints.create({ name: 'web', label: 'before-upgrade' });
  await Bun.write(disk, 'after the upgrade');
  await ctx.client.checkpoints.create({ name: 'web', label: 'after-upgrade' });
  await ctx.logIn();

  const rendered = renderApp('/imps/web');

  const row = await rendered.findByRole('row', { name: /before-upgrade/u });

  await user.click(within(row).getByRole('button', { name: 'Restore' }));

  const dialog = await rendered.findByRole('dialog', { name: 'Restore web?' });

  await user.click(within(dialog).getByRole('button', { name: 'Restore' }));

  await waitFor(async () => {
    const content = await Bun.file(disk).text();

    expect(content).toBe('before the upgrade');
  });
});

test('it opens the new imp after a fork from a checkpoint', async () => {
  const user = userEvent.setup();

  const ctx = await setupTest();

  await ctx.harness.createTestImage('base');
  await ctx.client.imps.create({ name: 'web' });
  await ctx.client.checkpoints.create({ name: 'web', label: 'before-upgrade' });
  await ctx.logIn();

  const rendered = renderApp('/imps/web');

  const row = await rendered.findByRole('row', { name: /before-upgrade/u });

  await user.click(within(row).getByRole('button', { name: 'Fork' }));

  const dialog = await rendered.findByRole('dialog', { name: 'Fork web' });

  await user.type(within(dialog).getByLabelText('New name'), 'web2');
  await user.click(within(dialog).getByRole('button', { name: 'Fork' }));
  await rendered.findByRole('heading', { name: 'web2' });

  const fork = await ctx.client.imps.get({ name: 'web2' });

  expect(rendered.router.state.location.pathname).toBe('/imps/web2');
  expect(fork.image).toBe('base');
});

test('it says so when the imp does not exist', async () => {
  const ctx = await setupTest();

  await ctx.logIn();

  const rendered = renderApp('/imps/gone');

  const alert = await rendered.findByRole('alert');

  expect(alert).toHaveTextContent('imp gone not found');
});

test('it goes back to the list without asking for the imp it destroyed', async () => {
  const user = userEvent.setup();
  const answered = mock<(status: number) => void>();

  const ctx = await setupTest();

  await ctx.harness.createTestImage('base');
  await ctx.client.imps.create({ name: 'web' });
  await ctx.logIn();

  server.events.on('response:mocked', (event: Readonly<Record<'response', Response>>) => {
    answered(event.response.status);
  });

  onTestFinished(() => {
    server.events.removeAllListeners('response:mocked');
  });

  const rendered = renderApp('/imps/web');

  const button = await rendered.findByRole('button', { name: 'Destroy' });

  await user.click(button);

  const dialog = await rendered.findByRole('dialog', { name: 'Destroy web?' });

  await user.click(within(dialog).getByRole('button', { name: 'Destroy' }));
  await rendered.findByRole('heading', { name: 'Imps' });

  expect(rendered.router.state.location.pathname).toBe('/');
  expect(answered).toHaveBeenCalledWith(200);
  expect(answered).not.toHaveBeenCalledWith(404);
});

test('it shows the network use and awake time of the running imp', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const counters = { rxBytes: 0, txBytes: 0 };

  // the database stamps the wake with the wall clock
  const clock = { nowMs: Date.now() };

  const dashboardImpd = await startDashboardImpd(stack, {
    boundaries: { imps: { now: () => clock.nowMs, readNetBytes: () => counters } },
  });

  const harness = dashboardImpd.harness;

  await harness.createTestImage('base');
  await harness.client.imps.create({ name: 'web' });

  counters.rxBytes = 2048;
  counters.txBytes = 512;

  // half a minute of slack for the time the create took
  clock.nowMs = Date.now() + 200 * 60_000 + 30_000;

  await harness.tickers.fire('resources');
  await dashboardImpd.logIn();

  const rendered = renderApp('/imps/web');

  const network = await rendered.findByText('2.0 KiB in, 512 B out');

  expect(network).toBeInTheDocument();
  expect(rendered.getByText('3h 20m')).toBeInTheDocument();
});

test('it sets a CPU limit on the running imp and keeps its weight', async () => {
  const user = userEvent.setup();

  const ctx = await setupTest();

  await ctx.harness.createTestImage('base');
  await ctx.client.imps.create({ name: 'web', cpuWeight: 200 });
  await ctx.logIn();

  const rendered = renderApp('/imps/web');

  const field = await rendered.findByLabelText('Limit (CPUs)');

  await user.type(field, '0.5');
  await user.click(rendered.getByRole('button', { name: 'Save' }));

  const cpu = await rendered.findByText(/ \/ 0\.5$/u);
  const imp = await ctx.client.imps.get({ name: 'web' });

  expect(cpu).toBeInTheDocument();
  expect(imp.cpu).toStrictEqual({ limit: 0.5, weight: 200 });
});
