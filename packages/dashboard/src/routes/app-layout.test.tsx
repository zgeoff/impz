import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderApp } from '../test-utils/render-app';
import { startDashboardImpd } from '../test-utils/start-dashboard-impd';

test('it tells every page that the host needs a reboot after a kernel oops', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const kernelDir = await mkdtemp(join(tmpdir(), 'dashboard-kernel-'));

  onTestFinished(() => rm(kernelDir, { recursive: true, force: true }));

  const dashboardImpd = await startDashboardImpd(stack, {
    kernelFiles: {
      taintPath: join(kernelDir, 'tainted'),
      bootIdPath: join(kernelDir, 'boot_id'),
      kmsgPath: join(kernelDir, 'kmsg'),
      pidNamespacePath: join(kernelDir, 'pid'),
    },
  });

  // the kernel's taint flag for an oops
  await writeFile(join(kernelDir, 'tainted'), '128\n');

  await dashboardImpd.logIn();

  const rendered = renderApp('/images');

  const warning = await rendered.findByRole('alert');

  expect(warning).toHaveTextContent('host needs a reboot: a kernel oops');
});

test('it shows no reboot warning while the host needs none', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dashboardImpd = await startDashboardImpd(stack);

  await dashboardImpd.logIn();

  const rendered = renderApp('/ram');

  await rendered.findByRole('meter', { name: 'RAM in use' });

  expect(rendered.queryByText(/host needs a reboot/v)).toBeNull();
});
