import { expect, onTestFinished, test } from 'bun:test';
import { readImpByName } from '@impz/daemon/testing';
import { within } from '@testing-library/react';
import invariant from 'tiny-invariant';
import { renderApp } from '../test-utils/render-app';
import { startDashboardImpd } from '../test-utils/start-dashboard-impd';

test('it lists imps by the RAM they own, largest first', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const ramByPid = new Map<number, number>();

  const dashboardImpd = await startDashboardImpd(stack, {
    boundaries: { imps: { readRamMib: (pid) => ramByPid.get(pid) ?? null } },
  });

  const harness = dashboardImpd.harness;

  await harness.createTestImage('base');
  await harness.client.imps.create({ name: 'idle' });
  await harness.client.imps.sleep({ name: 'idle' });
  await harness.client.imps.create({ name: 'small' });
  await harness.client.imps.create({ name: 'big' });

  const small = await readImpByName(harness.db, 'small');
  const big = await readImpByName(harness.db, 'big');

  invariant(typeof small?.pid === 'number' && typeof big?.pid === 'number');

  ramByPid.set(small.pid, 100);
  ramByPid.set(big.pid, 900);

  // impd keeps the first sample of each VM, so a restart reads the table afresh
  await harness.restartImpd();
  await dashboardImpd.logIn();

  const rendered = renderApp('/ram');

  await rendered.findByRole('row', { name: /big.*900 MiB/u });

  const names = rendered
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getByRole('link').textContent);

  expect(names).toStrictEqual(['big', 'small', 'idle']);
});

test('it shows the RAM an imp owns, its resident memory and its size', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dashboardImpd = await startDashboardImpd(stack);

  await dashboardImpd.harness.createTestImage('base');
  await dashboardImpd.harness.client.imps.create({ name: 'small', memoryMib: 2048 });
  await dashboardImpd.logIn();

  const rendered = renderApp('/ram');

  const row = await rendered.findByRole('row', { name: /small/u });

  expect(row).toHaveTextContent('300 MiB340 MiB2.0 GiB');
});

test('it shows the RAM meter of the host', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dashboardImpd = await startDashboardImpd(stack);

  await dashboardImpd.logIn();

  const rendered = renderApp('/ram');

  const meter = await rendered.findByRole('meter', { name: 'RAM in use' });

  expect(meter).toBeInTheDocument();
});
