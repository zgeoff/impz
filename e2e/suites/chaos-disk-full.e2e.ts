import { expect, onTestFinished, test } from 'bun:test';
import {
  collectStrayVms,
  listContainerVms,
  readLoopDevices,
  waitForImpd,
} from '@impz/e2e-harness/chaos';
import { config } from '@impz/e2e-harness/config';
import { resolveImageName } from '@impz/e2e-harness/fixtures';
import {
  createInstanceClient,
  listImps,
  requireImp,
  runImp,
  tryImp,
} from '@impz/e2e-harness/imp-cli';
import { waitForExec } from '@impz/e2e-harness/imps';
import { instance, runDevScript } from '@impz/e2e-harness/instance';
import { registerRemoval } from '@impz/e2e-harness/register-removal';
import { removeImpIfPresent } from '@impz/e2e-harness/reset-baseline';
import { getSuitePrefix } from '@impz/e2e-harness/suites';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: getSuitePrefix('chaos'), stack, client };
}

test('it keeps an imp awake with DISK_FULL when the disk cannot take its sleep', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}full`;

  await runImp('new', name, '--image', resolveImageName('e2e-bare'), '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  // A reserve past any test disk lets a wake through but refuses a sleep. The
  // imp comes first, as no create fits the reserve.
  await runDevScript('reboot', instance, { IMP_DISK_RESERVE_GIB: '100000' });

  ctx.stack.defer(() => runDevScript('reboot'));

  await waitForImpd();

  const devices = await readLoopDevices();
  const vms = await listContainerVms();
  const rows = await listImps();

  await runImp('wake', name);

  const result = await tryImp(['sleep', name]);
  const after = await requireImp(name);

  expect(devices.length).toBeLessThanOrEqual(1);
  expect(collectStrayVms(rows, vms)).toStrictEqual([]);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toStartWith('impz: DISK_FULL: '),
  });

  expect(after.state).toBe('running');
});
