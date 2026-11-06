import { expect, onTestFinished, test } from 'bun:test';
import { listAuditCalls } from '@impz/e2e-harness/audit';
import { config } from '@impz/e2e-harness/config';
import { resolveImageName } from '@impz/e2e-harness/fixtures';
import { createInstanceClient, runImp, tryImp } from '@impz/e2e-harness/imp-cli';
import { waitForExec } from '@impz/e2e-harness/imps';
import { registerRemoval } from '@impz/e2e-harness/register-removal';
import { removeImpIfPresent, removeTokenIfPresent } from '@impz/e2e-harness/reset-baseline';
import { runSsh, setupKeyClient } from '@impz/e2e-harness/ssh';
import { getSuitePrefix } from '@impz/e2e-harness/suites';
import invariant from 'tiny-invariant';

// One stack for every release, so a token goes before the imps it names.
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: getSuitePrefix('tokens'), stack, client };
}

test('it lets an exec token limited to dev-* run in its imp and not touch another, names it in the audit, and refuses it once removed', async () => {
  const ctx = await setupTest();

  const dev = `${ctx.prefix}exec-dev`;
  const other = `${ctx.prefix}exec-other`;
  const devExec = `${ctx.prefix}dev-exec`;

  await runImp('new', dev, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, dev));

  await runImp('new', other, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, other));

  await waitForExec(dev);
  await waitForExec(other);

  const made = await runImp('token', 'new', devExec, '--scope', 'exec', '--imps', `${dev}*`);

  registerRemoval(ctx.stack, config.keep, () => removeTokenIfPresent(ctx.client, devExec));

  const secret = made.trim();

  const own = await tryImp(['exec', dev, '--', 'echo', 'hi'], { token: secret });
  const otherExec = await tryImp(['exec', other, '--', 'true'], { token: secret });
  const otherStop = await tryImp(['stop', other], { token: secret });
  const otherProxy = await tryImp(['proxy', other, '0:8080'], { token: secret });
  const listed = await tryImp(['ls'], { token: secret });

  expect(own).toStrictEqual({ exitCode: 0, stdout: 'hi\n', stderr: '' });

  expect(otherExec).toStrictEqual({
    exitCode: 255,
    stdout: '',
    stderr: expect.toInclude('FORBIDDEN'),
  });

  expect(otherStop).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toInclude('FORBIDDEN'),
  });

  expect(otherProxy).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toInclude('FORBIDDEN'),
  });

  expect(listed).toStrictEqual({
    exitCode: 0,
    stdout: expect.toInclude(dev),
    stderr: '',
  });

  expect(listed.stdout).not.toContain(other);

  const calls = await listAuditCalls(other);

  expect(calls.find((call) => call.procedure === 'imps.stop')).toMatchObject({
    actor: 'token',
    actorName: devExec,
    outcome: 'FORBIDDEN',
  });

  await runImp('token', 'rm', devExec);

  const after = await tryImp(['ls'], { token: secret });

  expect(after).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr:
      'impz: unauthorized: set IMP_TOKEN to the token from <IMP_DATA_DIR>/token, or run impz login <url>\n',
  });
});

test('it lets an ssh key bound to a dev-* exec token log in to its imp and no other, names it in the audit, and lets it in nowhere once unbound', async () => {
  const ctx = await setupTest();

  const dev = `${ctx.prefix}key-dev`;
  const other = `${ctx.prefix}key-other`;
  const sshDev = `${ctx.prefix}ssh-dev`;
  const keyHost = 'imp-e2e-dev-key';

  await runImp('new', dev, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, dev));

  await runImp('new', other, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, other));

  await waitForExec(dev);
  await waitForExec(other);

  const keys = await setupKeyClient([keyHost]);

  ctx.stack.defer(() => keys.cleanup());

  const keyPath = keys.publicKeyPaths.get(keyHost);

  invariant(keyPath !== undefined);

  await runImp(
    'token',
    'new',
    sshDev,
    '--scope',
    'exec',
    '--imps',
    `${dev}*`,
    '--ssh-key',
    keyPath,
  );

  registerRemoval(ctx.stack, config.keep, () => removeTokenIfPresent(ctx.client, sshDev));

  const own = await runSsh(keys, dev, ['echo', 'in'], { host: keyHost });
  const refused = await runSsh(keys, other, ['echo', 'in'], { host: keyHost });

  expect(own).toStrictEqual({ exitCode: 0, stdout: 'in\n', stderr: '' });

  expect(refused).toStrictEqual({
    exitCode: 255,
    stdout: '',
    stderr: expect.toInclude('Permission denied'),
  });

  const calls = await listAuditCalls(dev);

  expect(calls.find((call) => call.actorName === sshDev)).toMatchObject({
    actor: 'ssh',
    outcome: 'ok',
  });

  const bound = await runImp('token', 'key', 'ls', sshDev);

  const [fingerprint] = bound.split(' ');

  invariant(fingerprint !== undefined);

  await runImp('token', 'key', 'rm', sshDev, fingerprint);

  const unbound = await runSsh(keys, dev, ['echo', 'in'], { host: keyHost });

  expect(unbound).toStrictEqual({
    exitCode: 255,
    stdout: '',
    stderr: expect.toInclude('Permission denied'),
  });
});

test('it opens no ssh session for a key bound to a read token', async () => {
  const ctx = await setupTest();

  const dev = `${ctx.prefix}read-key-dev`;
  const sshReader = `${ctx.prefix}ssh-reader`;
  const keyHost = 'imp-e2e-read-key';

  await runImp('new', dev, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, dev));

  await waitForExec(dev);

  const keys = await setupKeyClient([keyHost]);

  ctx.stack.defer(() => keys.cleanup());

  const keyPath = keys.publicKeyPaths.get(keyHost);

  invariant(keyPath !== undefined);

  await runImp('token', 'new', sshReader, '--scope', 'read', '--ssh-key', keyPath);

  registerRemoval(ctx.stack, config.keep, () => removeTokenIfPresent(ctx.client, sshReader));

  const refused = await runSsh(keys, dev, ['echo', 'in'], { host: keyHost });

  expect(refused).toStrictEqual({
    exitCode: 255,
    stdout: '',
    stderr: expect.toInclude('Permission denied'),
  });
});
