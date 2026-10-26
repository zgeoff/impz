import { expect, onTestFinished, test } from 'bun:test';
import { config } from '@impz/e2e-harness/config';
import { resolveImageName } from '@impz/e2e-harness/fixtures';
import {
  assertState,
  createInstanceClient,
  requireImp,
  runImp,
  runShellInImp,
} from '@impz/e2e-harness/imp-cli';
import { holdImp, waitForExec } from '@impz/e2e-harness/imps';
import { checkHealthReady, runDevScript } from '@impz/e2e-harness/instance';
import {
  collectJailViolations,
  listJailMounts,
  readImpCgroupText,
  readJailState,
  readVmProcess,
} from '@impz/e2e-harness/jail-host';
import { checkMemoryProof, startMemoryProof } from '@impz/e2e-harness/memory-proof';
import { parseWholeNumber } from '@impz/e2e-harness/parse-whole-number';
import { registerRemoval } from '@impz/e2e-harness/register-removal';
import { removeImpIfPresent } from '@impz/e2e-harness/reset-baseline';
import { getSuitePrefix } from '@impz/e2e-harness/suites';
import { waitFor } from '@impz/e2e-harness/wait-for';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: getSuitePrefix('jail'), stack, client };
}

test('it runs a new imp jailed under a memory cap, sleeps and wakes it full under the cap, and re-adopts it across an impd restart', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}box`;

  await runImp('new', name, '--image', resolveImageName('e2e-bare'), '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const booted = await readJailState(name);

  expect(collectJailViolations(booted)).toStrictEqual([]);

  await waitFor(`a RAM sample for ${name}`, async () => {
    const row = await requireImp(name);

    expect(row.ramMib).toBeGreaterThan(0);
  });

  const max = await readImpCgroupText(name, 'memory.max');
  const high = await readImpCgroupText(name, 'memory.high');
  const swapMax = await readImpCgroupText(name, 'memory.swap.max');
  const oomGroup = await readImpCgroupText(name, 'memory.oom.group');

  expect(parseWholeNumber(max, 'memory.max')).toBe((512 + 256) * 1024 * 1024);
  expect(high).toBe('max');
  expect(swapMax).toBe('0');
  expect(oomGroup).toBe('1');

  const proof = await startMemoryProof(name);

  await runShellInImp(
    name,
    [
      'mkdir -p /run/fill && mount -t tmpfs -o size=390m tmpfs /run/fill',
      'dd if=/dev/zero of=/run/fill/f bs=1M count=380 2>/dev/null',
    ].join('\n'),
  );

  await runImp('sleep', name);
  await assertState(name, 'sleeping');

  const asleepEvents = await readImpCgroupText(name, 'memory.events');

  // A boot template build has a jail of its own while it runs.
  const asleepMounts = await listJailMounts(`firecracker/${booted.impId}/`);

  expect(asleepEvents).toMatch(/^oom_kill 0$/mu);
  expect(asleepMounts).toStrictEqual([]);

  await runImp('wake', name);
  await waitForExec(name);
  await checkMemoryProof(proof);

  const size = await runShellInImp(name, 'cat /run/fill/f | wc -c');
  const wokeEvents = await readImpCgroupText(name, 'memory.events');
  const peak = await readImpCgroupText(name, 'memory.peak');
  const woke = await readJailState(name);

  expect(parseWholeNumber(size, 'the fill size')).toBe(380 * 1024 * 1024);
  expect(wokeEvents).toMatch(/^oom_kill 0$/mu);
  expect(parseWholeNumber(peak, 'memory.peak')).toBeLessThanOrEqual((512 + 256) * 1024 * 1024);
  expect(collectJailViolations(woke)).toStrictEqual([]);

  const beforeRestart = await readVmProcess(name);

  await runDevScript('restart');

  await waitFor('impd to be ready', async () => {
    const isReady = await checkHealthReady();

    expect(isReady).toBeTrue();
  });

  const afterRestart = await readVmProcess(name);

  expect(afterRestart.pid).toBe(beforeRestart.pid);

  await assertState(name, 'running');
  await checkMemoryProof(proof);

  await waitFor(`a RAM sample for ${name} after the restart`, async () => {
    const row = await requireImp(name);

    expect(row.ramMib).toBeGreaterThan(0);
  });
});
