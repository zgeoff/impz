import { expect, onTestFinished, test } from 'bun:test';
import { config } from '@impz/e2e-harness/config';
import { resolveImageName } from '@impz/e2e-harness/fixtures';
import { createInstanceClient, readImp, runImp, runImpWith } from '@impz/e2e-harness/imp-cli';
import { waitForExec, writeGuestFile } from '@impz/e2e-harness/imps';
import { runInContainer } from '@impz/e2e-harness/instance';
import { HOST_B, readMoveHosts, readMoveOptions } from '@impz/e2e-harness/move-hosts';
import { registerRemoval } from '@impz/e2e-harness/register-removal';
import { removeImpIfPresent } from '@impz/e2e-harness/reset-baseline';
import { getSuitePrefix } from '@impz/e2e-harness/suites';
import { parseSelfTags, waitForTailnetIp } from '@impz/e2e-harness/tailnet';
import { waitFor } from '@impz/e2e-harness/wait-for';

// One stack for every release, so B's imps go before B.
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: getSuitePrefix('moves-tailnet'), stack, client };
}

test('it moves an imp between two tailnet nodes, past the peer check on their tailnet addresses', async () => {
  const ctx = await setupTest();

  const plain = `${ctx.prefix}a`;
  const hosts = readMoveHosts(readMoveOptions('host-b-tailnet'));

  const clientB = await createInstanceClient(hosts.hostB);
  const ipA = await waitForTailnetIp();
  const ipB = await waitForTailnetIp({ target: hosts.hostB });

  expect(ipA).toStartWith('100.');
  expect(ipB).toStartWith('100.');
  expect(ipB).not.toBe(ipA);

  const statusA = await runInContainer(['tailscale', 'status', '--json']);
  const statusB = await runInContainer(['tailscale', 'status', '--json'], hosts.hostB);

  expect(parseSelfTags(statusA.stdout)).toStrictEqual(['tag:imp-e2e']);
  expect(parseSelfTags(statusB.stdout)).toStrictEqual(['tag:imp-e2e']);

  // tag:imp-e2e nodes see each other only through the policy's tag:imp-e2e to
  // tag:imp-e2e:7070 grant.
  await waitFor(
    "A among B's tailnet peers",
    async () => {
      const status = await runInContainer(['tailscale', 'status', '--json'], hosts.hostB);

      if (!status.stdout.includes(`"${ipA}"`)) {
        throw new Error(
          `B does not see A (${ipA}): e2e/fixtures/headscale/policy.hujson needs the tag:imp-e2e to tag:imp-e2e tcp:7070 grant`,
        );
      }
    },
    { timeoutMs: 30_000 },
  );

  await runImp('new', plain, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, plain));

  await waitForExec(plain);
  await writeGuestFile(plain, '/root/moved', 'tailnet-ok');
  await runImp('stop', plain);

  const out = await runImpWith({ env: hosts.cliEnv }, 'move', plain, HOST_B);

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(clientB, plain));

  const left = await readImp(plain);

  expect(out).toContain(`${plain}: moved to ${HOST_B}`);
  expect(left).toBeUndefined();

  await runImpWith({ target: hosts.hostB }, 'start', plain);

  const content = await waitFor(`${plain} to boot on B`, () =>
    runImpWith({ target: hosts.hostB }, 'exec', plain, '--', 'cat', '/root/moved'),
  );

  expect(content).toBe('tailnet-ok\n');
});
