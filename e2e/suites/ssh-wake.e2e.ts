import { expect, onTestFinished, test } from 'bun:test';
import { waitAwakePastIdle } from '../lib/awake-past-idle';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { assertState, createInstanceClient, readState, runImp } from '../lib/imp-cli';
import { waitForExec } from '../lib/imps';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { SSH_HOST, SSH_HOST_OTHER_KEY, runSsh, setupSshClient, startSsh } from '../lib/ssh';
import { getSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';
import { writeMetric } from '../lib/write-metric';

// One stack for every release, so ssh stops before the imp goes.
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();
  const ssh = await setupSshClient();

  stack.defer(() => ssh.cleanup());

  return { prefix: getSuitePrefix('ssh-wake'), stack, client, ssh };
}

test('it wakes a sleeping imp on ssh but not on a refused login, and keeps it awake while a connection is open', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}a`;

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await runImp('sleep', name);

  const unknownUser = await runSsh(ctx.ssh, 'nobody', ['true']);
  const unknownKey = await runSsh(ctx.ssh, name, ['true'], { host: SSH_HOST_OTHER_KEY });
  const afterRefusals = await readState(name);

  expect(unknownUser).toStrictEqual({
    exitCode: 255,
    stdout: '',
    stderr: expect.toInclude('Permission denied (publickey)'),
  });

  expect(unknownKey).toStrictEqual({
    exitCode: 255,
    stdout: '',
    stderr: expect.toInclude('Permission denied (publickey)'),
  });

  expect(afterRefusals).toBe('sleeping');

  const started = Date.now();

  const woken = await runSsh(ctx.ssh, name, ['echo awake']);

  writeMetric('sshWakeExecMs', Date.now() - started);

  const afterLogin = await readState(name);

  expect(woken.stdout).toBe('awake\n');
  expect(afterLogin).toBe('running');

  const held = startSsh(ctx.ssh, ['-N', `${name}@${SSH_HOST}`]);

  ctx.stack.defer(() => held.stop());

  const holding = Date.now();

  await waitAwakePastIdle(name, holding);

  await held.stop();

  await waitFor(`${name} to sleep`, () => assertState(name, 'sleeping'), {
    timeoutMs: (config.idleTimeoutS + 15) * 1000,
  });
});
