import { expect, onTestFinished, test } from 'bun:test';
import { config } from '@impz/e2e-harness/config';
import { resolveImageName } from '@impz/e2e-harness/fixtures';
import { readThroughProxy } from '@impz/e2e-harness/http';
import {
  assertState,
  createInstanceClient,
  readState,
  runImp,
  runShellInImp,
  tryImp,
} from '@impz/e2e-harness/imp-cli';
import { holdImp, readGuestFile, waitForExec, writeGuestFile } from '@impz/e2e-harness/imps';
import { checkHealthReady, readImpdPid, runDevScript } from '@impz/e2e-harness/instance';
import { checkMemoryProof, startMemoryProof } from '@impz/e2e-harness/memory-proof';
import { registerRemoval } from '@impz/e2e-harness/register-removal';
import { removeImpIfPresent } from '@impz/e2e-harness/reset-baseline';
import {
  buildKeptScaleFleet,
  listAwakeImps,
  readInventory,
} from '@impz/e2e-harness/restart-inventory';
import { getSuitePrefix } from '@impz/e2e-harness/suites';
import { waitFor } from '@impz/e2e-harness/wait-for';
import { writeMetric } from '@impz/e2e-harness/write-metric';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: getSuitePrefix('restart'), stack, client };
}

test('it re-adopts running VMs across an impd restart, wakes a sleeper and restores a checkpoint, then sleeps every imp across a reboot', async () => {
  const ctx = await setupTest();

  const disk = `${ctx.prefix}disk`;
  const mem = `${ctx.prefix}mem`;
  const stopped = `${ctx.prefix}stopped`;

  await runImp('new', disk, '--image', resolveImageName('e2e-tiny'), '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, disk));

  await waitForExec(disk);
  await holdImp(disk);
  await writeGuestFile(disk, '/root/f', 'r1');
  await runImp('checkpoint', disk, 'r1');
  await writeGuestFile(disk, '/root/f', 'r2');

  const diskBootId = await runShellInImp(disk, 'cat /proc/sys/kernel/random/boot_id');

  await runImp('new', mem, '--image', resolveImageName('e2e-bare'), '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, mem));

  await waitForExec(mem);

  const proof = await startMemoryProof(mem);

  // The idle sleeper may get there first.
  await tryImp(['sleep', mem]);
  await waitFor(`${mem} to sleep`, () => assertState(mem, 'sleeping'));
  await runImp('new', stopped, '--image', resolveImageName('e2e-tiny'), '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, stopped));

  await waitForExec(stopped);
  await runImp('stop', stopped);

  const beforeRestart = await readInventory();
  const oldPid = await readImpdPid();

  console.log(`    ${String(beforeRestart.length)} imps before the restart`);

  expect(beforeRestart.map((entry) => entry.name)).toIncludeAllMembers(
    buildKeptScaleFleet(config.keptPrefixes, config.scaleCount),
  );

  const restarting = Date.now();

  // dev.sh restart can return while the old impd still answers /health, so
  // wait for a new impd process before trusting readiness.
  await runDevScript('restart');

  const newPid = await waitFor(
    'a new impd process',
    async () => {
      const pid = await readImpdPid();

      if (pid === null || pid === oldPid) {
        throw new Error(`impd pid ${String(pid)}, was ${String(oldPid)}`);
      }

      return pid;
    },
    { timeoutMs: 180_000 },
  );

  await waitFor(
    'the new impd to be ready',
    async () => {
      const ready = await checkHealthReady();

      if (!ready) {
        throw new Error('impd is not ready');
      }
    },
    { timeoutMs: 120_000 },
  );

  writeMetric('restartMs', Date.now() - restarting);

  const afterRestart = await readInventory();
  const diskState = await readState(disk);
  const bootId = await runShellInImp(disk, 'cat /proc/sys/kernel/random/boot_id');
  const file = await readGuestFile(disk, '/root/f');
  const stoppedState = await readState(stopped);

  expect(oldPid).not.toBeNull();
  expect(newPid).not.toBe(oldPid);
  expect(afterRestart).toStrictEqual(beforeRestart);
  expect(diskState).toBe('running');
  expect(bootId).toBe(diskBootId);
  expect(file).toBe('r2');
  expect(stoppedState).toBe('stopped');

  const woken = await readThroughProxy(mem);

  expect(woken).toBe(proof.token);

  await checkMemoryProof(proof);
  await runImp('restore', disk, 'r1');
  await waitForExec(disk);

  const restored = await readGuestFile(disk, '/root/f');

  expect(restored).toBe('r1');

  await holdImp(mem);

  const beforeReboot = await readInventory();

  const rebooting = Date.now();

  // SIGTERM makes impd sleep every VM before it exits.
  await runDevScript('reboot');

  writeMetric('rebootMs', Date.now() - rebooting);

  const afterReboot = await readInventory();
  const awake = await listAwakeImps();
  const memState = await readState(mem);
  const stoppedAfterReboot = await readState(stopped);

  expect(afterReboot).toStrictEqual(beforeReboot);
  expect(awake).toStrictEqual([]);
  expect(memState).toBe('sleeping');
  expect(stoppedAfterReboot).toBe('stopped');

  const body = await readThroughProxy(mem);

  expect(body).toBe(proof.token);

  await checkMemoryProof(proof);
});
