import { expect, onTestFinished, test } from 'bun:test';
import { config } from '@impz/e2e-harness/config';
import { resolveImageName } from '@impz/e2e-harness/fixtures';
import {
  createInstanceClient,
  listImageNames,
  runImp,
  runShellInImp,
  tryImp,
} from '@impz/e2e-harness/imp-cli';
import {
  holdImp,
  readGuestFile,
  readGuestIdentity,
  waitForExec,
  writeGuestFile,
} from '@impz/e2e-harness/imps';
import { registerRemoval } from '@impz/e2e-harness/register-removal';
import { removeImageIfPresent, removeImpIfPresent } from '@impz/e2e-harness/reset-baseline';
import { getSuitePrefix } from '@impz/e2e-harness/suites';

// One stack for every release, so each imp goes before the template it boots.
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: getSuitePrefix('templates'), stack, client };
}

test('it copies a running imp into a template whose copies each get their own identity, and removes the template once no imp boots it', async () => {
  const ctx = await setupTest();

  const source = `${ctx.prefix}src`;
  const template = `${ctx.prefix}golden`;
  const first = `${ctx.prefix}a`;
  const second = `${ctx.prefix}b`;
  const sourceId = '0123456789abcdef0123456789abcdef';

  await runImp('new', source, '--image', resolveImageName('e2e-git'), '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, source));

  await waitForExec(source);
  await holdImp(source);

  await runShellInImp(
    source,
    `echo ${sourceId} | sudo tee /etc/machine-id >/dev/null && sudo ssh-keygen -A >/dev/null`,
  );

  await writeGuestFile(source, '/home/dev/marker', 'golden');

  const sourceIdentity = await readGuestIdentity(source);

  expect(sourceIdentity.machineId).toBe(sourceId);
  expect(sourceIdentity.hostKey).toStartWith('SHA256:');

  await runImp('template', 'create', source, template);

  registerRemoval(ctx.stack, config.keep, () => removeImageIfPresent(ctx.client, template));

  const templates = await runImp('template', 'ls');

  expect(templates).toContain(template);
  expect(templates).toContain(`imp:${source}`);

  await runImp('new', first, '--image', template, '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, first));

  await runImp('new', second, '--image', template, '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, second));

  await waitForExec(first);
  await waitForExec(second);

  const firstIdentity = await readGuestIdentity(first);
  const secondIdentity = await readGuestIdentity(second);
  const marker = await readGuestFile(first, '/home/dev/marker');

  expect(firstIdentity.machineId).toMatch(/^[\da-f]{32}$/u);
  expect(firstIdentity.machineId).not.toBe(sourceId);
  expect(firstIdentity.hostKey).toStartWith('SHA256:');
  expect(firstIdentity.hostKey).not.toBe(sourceIdentity.hostKey);
  expect(secondIdentity.machineId).toMatch(/^[\da-f]{32}$/u);
  expect(secondIdentity.machineId).not.toBe(sourceId);
  expect(secondIdentity.hostKey).toStartWith('SHA256:');
  expect(secondIdentity.hostKey).not.toBe(sourceIdentity.hostKey);
  expect(secondIdentity.machineId).not.toBe(firstIdentity.machineId);
  expect(secondIdentity.hostKey).not.toBe(firstIdentity.hostKey);
  expect(marker).toBe('golden');

  await runImp('stop', first);
  await runImp('start', first);

  const rebooted = await readGuestIdentity(first);

  expect(rebooted).toStrictEqual(firstIdentity);

  const inUse = await tryImp(['template', 'rm', template]);

  expect(inUse).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: `impz: CONFLICT: image ${template} is used by 2 imp(s)\n`,
  });

  await runImp('rm', first);
  await runImp('rm', second);
  await runImp('template', 'rm', template);

  const images = await listImageNames();

  expect(images).not.toContain(template);
});
