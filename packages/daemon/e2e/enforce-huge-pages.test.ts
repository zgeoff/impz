import { expect, onTestFinished, test } from 'bun:test';
import { removeShapeTemplates, waitForShapeTemplate } from '@impz/e2e-harness/boot-template-guest';
import { config } from '@impz/e2e-harness/config';
import { resolveImageName } from '@impz/e2e-harness/fixtures';
import {
  checkHostHasHugePagePool,
  readHandlerPid,
  readVmHugetlbMib,
} from '@impz/e2e-harness/huge-page-host';
import {
  createInstanceClient,
  requireImp,
  runImp,
  runInImp,
  runShellInImp,
} from '@impz/e2e-harness/imp-cli';
import { waitForExec } from '@impz/e2e-harness/imps';
import { runInContainer } from '@impz/e2e-harness/instance';
import { registerRemoval } from '@impz/e2e-harness/register-removal';
import { removeImpIfPresent } from '@impz/e2e-harness/reset-baseline';
import { getSuitePrefix } from '@impz/e2e-harness/suites';
import { waitFor } from '@impz/e2e-harness/wait-for';
import { writeMetric } from '@impz/e2e-harness/write-metric';

// Each test boots a memory size of its own, so a template one test leaves
// under --keep is no other test's.

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: getSuitePrefix('huge-pages'), stack, client };
}

test.skipIf(!checkHostHasHugePagePool())(
  'it boots an imp on huge pages and wakes it through its page handler, its memory kept',
  async () => {
    const ctx = await setupTest();

    const name = `${ctx.prefix}wake`;

    await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--memory', '256m');

    registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

    await waitForExec(name);

    const bootedMib = await readVmHugetlbMib(name);

    // tmpfs lives in guest RAM, so only the restored memory can bring it back,
    // and random bytes across several huge pages show a page served wrong
    const asleepSum = await runShellInImp(
      name,
      'dd if=/dev/urandom of=/dev/shm/sentinel bs=1M count=8 2>/dev/null && sha256sum /dev/shm/sentinel',
    );

    await runImp('sleep', name);

    const wokenSum = await runShellInImp(name, 'sha256sum /dev/shm/sentinel');
    const wokenMib = await readVmHugetlbMib(name);
    const handlerPid = await readHandlerPid(name);

    writeMetric('huge_pages_hugetlb_mib', { booted: bootedMib, woken: wokenMib });

    expect(bootedMib).toBeGreaterThan(0);
    expect(wokenSum).toBe(asleepSum);
    expect(wokenMib).toBeGreaterThan(0);
    expect(handlerPid).not.toBeNull();
  },
);

test.skipIf(!checkHostHasHugePagePool())(
  'it restores a boot template on huge pages through a page handler',
  async () => {
    const ctx = await setupTest();

    const image = resolveImageName('e2e-tiny');
    const first = `${ctx.prefix}tpl-a`;
    const spare = `${ctx.prefix}tpl-x`;
    const restored = `${ctx.prefix}tpl-b`;

    registerRemoval(ctx.stack, config.keep, () => removeShapeTemplates(258));

    await removeShapeTemplates(258);
    await runImp('new', first, '--image', image, '--memory', '258', '--cpus', '1');

    registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, first));

    await waitForExec(first);
    await runImp('rm', first);
    await runImp('new', spare, '--image', image, '--memory', '258', '--cpus', '1');

    registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, spare));

    await waitForExec(spare);
    await runImp('rm', spare);
    await waitForShapeTemplate(258);
    await runImp('new', restored, '--image', image, '--memory', '258', '--cpus', '1');

    registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, restored));

    await waitForExec(restored);

    const hostname = await runInImp(restored, 'hostname');
    const handlerPid = await readHandlerPid(restored);
    const hugetlbMib = await readVmHugetlbMib(restored);

    writeMetric('huge_pages_restored_hugetlb_mib', hugetlbMib);

    expect(hostname).toBe(restored);
    expect(handlerPid).not.toBeNull();
    expect(hugetlbMib).toBeGreaterThan(0);
  },
);

test.skipIf(!checkHostHasHugePagePool())(
  'it stops the VM of an imp whose page handler dies, and leaves no Firecracker waiting on it',
  async () => {
    const ctx = await setupTest();

    const name = `${ctx.prefix}crash`;

    await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--memory', '256m');

    registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

    await waitForExec(name);
    await runImp('sleep', name);
    await runInImp(name, 'true');

    const imp = await requireImp(name);
    const handlerPid = await readHandlerPid(name);

    if (handlerPid === null) {
      throw new Error(`${name} woke with no page handler`);
    }

    await runInContainer(['kill', '-KILL', handlerPid]);

    const state = await waitFor(
      `${name} to stop once its page handler is gone`,
      async () => {
        const row = await requireImp(name);

        const vm = await runInContainer([
          'sh',
          '-c',
          `kill -0 "$(cat /var/lib/imp/imps/${imp.id}/run/pid)"`,
        ]);

        if (row.state === 'running' || vm.exitCode === 0) {
          throw new Error(
            `${name} is ${row.state}, its Firecracker alive: ${String(vm.exitCode === 0)}`,
          );
        }

        return row.state;
      },
      { timeoutMs: 30_000, intervalMs: 500 },
    );

    expect(state).not.toBe('running');
  },
);
