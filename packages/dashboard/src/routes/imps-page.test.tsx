import { expect, onTestFinished, test } from 'bun:test';
import { waitFor } from '@impz/test-utils/wait-for';
import { within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../test-utils/render-app';
import { startDashboardImpd } from '../test-utils/start-dashboard-impd';

async function setupTest(env: Readonly<Record<string, string>> = {}) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dashboardImpd = await startDashboardImpd(stack, { env });

  return {
    harness: dashboardImpd.harness,
    client: dashboardImpd.harness.client,
    logIn: dashboardImpd.logIn,
    waitForEventStream: dashboardImpd.waitForEventStream,
  };
}

test('it lists a running imp with its state, RAM, disk and a sleep button', async () => {
  const ctx = await setupTest();

  await ctx.harness.createTestImage('base');
  await ctx.client.imps.create({ name: 'web', diskMib: 32_768 });
  await ctx.logIn();

  const rendered = renderApp();

  const row = await rendered.findByRole('row', { name: /web/u });

  expect(within(row).getByText('running')).toBeInTheDocument();
  expect(within(row).getByText(/300 MiB/u)).toBeInTheDocument();
  expect(within(row).getByText('— / 32.0 GiB')).toBeInTheDocument();
  expect(within(row).getByRole('button', { name: 'Sleep' })).toBeInTheDocument();
});

test('it lists a sleeping imp with its notes and a wake button', async () => {
  const ctx = await setupTest();

  await ctx.harness.createTestImage('base');
  await ctx.client.imps.create({ name: 'old' });
  await ctx.client.imps.sleep({ name: 'old' });

  const before = ctx.harness.readIdentity();

  await ctx.harness.restartImpd({ ...before, hostKernel: '6.99.0' });
  await ctx.logIn();

  const rendered = renderApp();

  const row = await rendered.findByRole('row', { name: /old/u });

  expect(
    within(row).getByText(
      `next wake boots cold: hostKernel changed (${before.hostKernel} → 6.99.0)`,
    ),
  ).toBeInTheDocument();

  expect(within(row).getByRole('button', { name: 'Wake' })).toBeInTheDocument();
});

test('it lists a failed imp with its error and a restart button', async () => {
  const ctx = await setupTest();

  await ctx.harness.createTestImage('base');

  ctx.harness.fake.queue('boot', 'fail');

  await ctx.client.imps.create({ name: 'bad' }).catch(() => null);
  await ctx.logIn();

  const failed = await ctx.client.imps.get({ name: 'bad' });

  const rendered = renderApp();

  const row = await rendered.findByRole('row', { name: /bad/u });

  expect(within(row).getByText(failed.error ?? 'no error')).toBeInTheDocument();
  expect(within(row).getByRole('button', { name: 'Restart' })).toBeInTheDocument();
});

test('it shows the RAM in use against the budget of the host', async () => {
  const ctx = await setupTest({ IMP_RAM_BUDGET_MIB: '4096' });

  await ctx.harness.createTestImage('base');
  await ctx.client.imps.create({ name: 'web' });
  await ctx.logIn();

  const rendered = renderApp();

  const meter = await rendered.findByRole('meter', { name: 'RAM in use' });

  expect(meter).toHaveAttribute('aria-valuenow', '300');
  expect(rendered.getByText('300 MiB of 4.0 GiB')).toBeInTheDocument();
});

test('it invites a first imp when there are none', async () => {
  const ctx = await setupTest();

  await ctx.logIn();

  const rendered = renderApp();

  const invite = await rendered.findByText('No imps yet. Make one with New imp.');

  expect(invite).toBeInTheDocument();
});

test('it moves the row of an imp to the state its lifecycle button asks for', async () => {
  const user = userEvent.setup();

  const ctx = await setupTest();

  await ctx.harness.createTestImage('base');
  await ctx.client.imps.create({ name: 'web' });
  await ctx.logIn();

  const rendered = renderApp();

  const row = await rendered.findByRole('row', { name: /web/u });

  await user.click(within(row).getByRole('button', { name: 'Sleep' }));

  const state = await within(row).findByText('sleeping');
  const imp = await ctx.client.imps.get({ name: 'web' });

  expect(state).toBeInTheDocument();
  expect(imp.state).toBe('sleeping');
});

test('it asks before destroying an imp', async () => {
  const user = userEvent.setup();

  const ctx = await setupTest();

  await ctx.harness.createTestImage('base');
  await ctx.client.imps.create({ name: 'web' });
  await ctx.logIn();

  const rendered = renderApp();

  const row = await rendered.findByRole('row', { name: /web/u });

  await user.click(within(row).getByRole('button', { name: 'Destroy' }));

  const dialog = await rendered.findByRole('dialog', { name: 'Destroy web?' });
  const imps = await ctx.client.imps.list();

  expect(dialog).toBeInTheDocument();
  expect(imps.map((imp) => imp.name)).toStrictEqual(['web']);
});

test('it destroys an imp once the destroy is confirmed', async () => {
  const user = userEvent.setup();

  const ctx = await setupTest();

  await ctx.harness.createTestImage('base');
  await ctx.client.imps.create({ name: 'web' });
  await ctx.logIn();

  const rendered = renderApp();

  const row = await rendered.findByRole('row', { name: /web/u });

  await user.click(within(row).getByRole('button', { name: 'Destroy' }));

  const dialog = await rendered.findByRole('dialog', { name: 'Destroy web?' });

  await user.click(within(dialog).getByRole('button', { name: 'Destroy' }));

  await waitFor(() => {
    expect(rendered.queryByRole('row', { name: /web/u })).toBeNull();
  });

  const imps = await ctx.client.imps.list();

  expect(imps).toStrictEqual([]);
});

test('it creates a new imp from only the fields that were filled in', async () => {
  const user = userEvent.setup();

  const ctx = await setupTest({ IMP_DEFAULT_IMAGE: 'node' });

  await ctx.harness.createTestImage('node');
  await ctx.logIn();

  const rendered = renderApp();

  const button = await rendered.findByRole('button', { name: 'New imp' });

  await user.click(button);

  const dialog = await rendered.findByRole('dialog', { name: 'New imp' });

  await user.type(within(dialog).getByLabelText('Name'), 'box');
  await user.type(within(dialog).getByLabelText('Memory (MiB)'), '512');
  await user.click(within(dialog).getByRole('button', { name: 'Create' }));
  await rendered.findByRole('row', { name: /box/u });

  const imp = await ctx.client.imps.get({ name: 'box' });

  expect(imp).toMatchObject({ name: 'box', image: 'node', memoryMib: 512, vcpus: 2 });
});

// the views refetch on a timer far longer than a find waits, so only the event
// stream can show the change in time
test('it shows a change impd streams without waiting for the next poll', async () => {
  const ctx = await setupTest();

  await ctx.harness.createTestImage('base');
  await ctx.client.imps.create({ name: 'web' });
  await ctx.logIn();

  const rendered = renderApp();

  const row = await rendered.findByRole('row', { name: /web/u });

  await ctx.waitForEventStream();
  await ctx.client.imps.sleep({ name: 'web' });

  const state = await within(row).findByText('sleeping');

  expect(state).toBeInTheDocument();
});
