import { expect, onTestFinished, test } from 'bun:test';
import { config } from '@impz/e2e-harness/config';
import { resolveImageName } from '@impz/e2e-harness/fixtures';
import { assertState, createInstanceClient, requireImp, runImp } from '@impz/e2e-harness/imp-cli';
import { waitForExec } from '@impz/e2e-harness/imps';
import { readImpdLogSince, runInContainer } from '@impz/e2e-harness/instance';
import {
  collectJailViolations,
  hasTemplateBuildEnded,
  listJailMounts,
  readJailState,
  readTemplateKey,
} from '@impz/e2e-harness/jail-host';
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

test('it starts, stops and removes a jailed VM cleanly, and the boot template build leaves no jail mounted', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}rm`;

  // The second cold boot of a shape since impd started builds its boot template
  // in the background, unless one exists.
  const since = new Date();

  await runImp('new', name, '--image', resolveImageName('e2e-bare'), '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await runImp('stop', name);
  await runImp('start', name);
  await waitForExec(name);

  const started = await readJailState(name);

  expect(collectJailViolations(started)).toStrictEqual([]);

  await runImp('stop', name);
  await assertState(name, 'stopped');

  const row = await requireImp(name);
  const stoppedMounts = await listJailMounts(`firecracker/${row.id}/`);

  expect(stoppedMounts).toStrictEqual([]);

  await runImp('start', name);
  await waitForExec(name);

  const key = await readTemplateKey(name);

  await runImp('rm', name);

  const jail = await runInContainer(['ls', `/var/lib/imp/jail/firecracker/${row.id}`]);
  const cgroup = await runInContainer(['ls', `/sys/fs/cgroup/imps/${row.id}`]);
  const removedMounts = await listJailMounts(`firecracker/${row.id}/`);

  expect(jail.exitCode).not.toBe(0);
  expect(cgroup.exitCode).not.toBe(0);
  expect(removedMounts).toStrictEqual([]);

  await waitFor('the imp’s boot template build to end', async () => {
    const log = await readImpdLogSince(since);

    if (!hasTemplateBuildEnded(log, name, key)) {
      throw new Error(`no end of the ${key.slice(0, 12)} build logged yet`);
    }
  });

  const mounts = await listJailMounts('');

  expect(mounts).toStrictEqual([]);
});
