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
  runInImp,
} from '@impz/e2e-harness/imp-cli';
import { holdImp, waitForExec } from '@impz/e2e-harness/imps';
import { instance, runDevScript, runInContainer } from '@impz/e2e-harness/instance';
import { checkMemoryKept, startMemoryProof } from '@impz/e2e-harness/memory-proof';
import { registerRemoval } from '@impz/e2e-harness/register-removal';
import { removeImpIfPresent } from '@impz/e2e-harness/reset-baseline';
import { getSuitePrefix } from '@impz/e2e-harness/suites';
import { waitFor } from '@impz/e2e-harness/wait-for';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: getSuitePrefix('chaos'), stack, client };
}

test('it restarts a paused VM whose agent stops answering with the watchdog', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}dog`;

  // A watchdog this short would trip during the seeded kill rounds.
  await runDevScript('reboot', instance, {
    IMP_WATCHDOG_ACTION: 'restart',
    IMP_WATCHDOG_TIMEOUT_S: '10',
  });

  ctx.stack.defer(() => runDevScript('reboot'));

  await waitForImpd();

  const devices = await readLoopDevices();
  const vms = await listContainerVms();
  const rows = await listImps();

  await runImp('new', name, '--image', resolveImageName('e2e-bare'), '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const proof = await startMemoryProof(name);
  const row = await requireImp(name);

  await runInContainer([
    'curl',
    '-fsS',
    '--unix-socket',
    `/var/lib/imp/imps/${row.id}/run/api.sock`,
    '-X',
    'PATCH',
    'http://localhost/vm',
    '-d',
    '{"state":"Paused"}',
  ]);

  const restarted = await waitFor(
    `${name} to boot cold by the watchdog`,
    async () => {
      const current = await requireImp(name);

      if (!(current.coldBootReason ?? '').includes('watchdog')) {
        throw new Error(`cold boot reason ${current.coldBootReason ?? 'none'}`);
      }

      return current;
    },
    { timeoutMs: 120_000 },
  );

  await runInImp(name, 'true');

  const isKept = await checkMemoryKept(proof);

  expect(devices.length).toBeLessThanOrEqual(1);
  expect(collectStrayVms(rows, vms)).toStrictEqual([]);
  expect(restarted.coldBootReason).toContain('watchdog');
  expect(isKept).toBeFalse();
});
