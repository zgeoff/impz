import { expect, onTestFinished, test } from 'bun:test';
import { config } from '@impz/e2e-harness/config';
import { resolveImageName } from '@impz/e2e-harness/create-missing-images';
import { instance, runDevScript } from '@impz/e2e-harness/instance';
import { checkMemoryProof, startMemoryProof } from '@impz/e2e-harness/memory-proof';
import {
  collectJailViolations,
  readJailState,
  readStatusField,
  readVmProcess,
} from '@impz/e2e-harness/read-jail-state';
import { registerRemoval } from '@impz/e2e-harness/register-removal';
import { removeImpIfPresent } from '@impz/e2e-harness/reset-baseline';
import { createInstanceClient, runImp } from '@impz/e2e-harness/run-imp';
import { getSuitePrefix } from '@impz/e2e-harness/suites';
import { holdImp, waitForExec } from '@impz/e2e-harness/wait-for-exec';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: getSuitePrefix('jail'), stack, client };
}

test('it wakes a jailed snapshot as root in an impd without the jailer, and that snapshot jailed again after the upgrade', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}roll`;

  await runImp('new', name, '--image', resolveImageName('e2e-bare'), '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const proof = await startMemoryProof(name);

  // In-test, not suite settings: the jail suite's other files need the jailer on.
  await runDevScript('reboot', instance, { IMP_JAILER: 'false' });
  await runImp('wake', name);
  await waitForExec(name);
  await checkMemoryProof(proof);

  const rolledBack = await readVmProcess(name);

  expect(rolledBack.cmdline).not.toContain('--id');
  expect(readStatusField(rolledBack.status, 'Uid').split(/\s+/v)[0]).toBe('0');

  await runDevScript('reboot');
  await runImp('wake', name);
  await waitForExec(name);
  await checkMemoryProof(proof);

  const upgraded = await readJailState(name);

  expect(collectJailViolations(upgraded)).toStrictEqual([]);
});
