import { expect, onTestFinished, test } from 'bun:test';
import { config } from '@impz/e2e-harness/config';
import { resolveImageName } from '@impz/e2e-harness/fixtures';
import {
  createInstanceClient,
  readImpUrls,
  readInfo,
  requireImp,
  runImp,
  runImpWith,
} from '@impz/e2e-harness/imp-cli';
import { waitForExec } from '@impz/e2e-harness/imps';
import { runChecked } from '@impz/e2e-harness/instance';
import { HOST_B, readMoveHosts, readMoveOptions } from '@impz/e2e-harness/move-hosts';
import { registerRemoval } from '@impz/e2e-harness/register-removal';
import { removeImpIfPresent } from '@impz/e2e-harness/reset-baseline';
import { getSuitePrefix } from '@impz/e2e-harness/suites';
import {
  findServiceUrl,
  isTailnetReady,
  readHarnessMemberStatus,
  readMemberBody,
  readTailnetMember,
} from '@impz/e2e-harness/tailnet';
import { probeTailscaleE2EKey } from '@impz/e2e-harness/tailscale-key';
import { waitFor } from '@impz/e2e-harness/wait-for';

// One stack for every release, so B's imps go before B.
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: getSuitePrefix('tailnet-names'), stack, client };
}

// collection-time gate: Bun's skipIf takes a boolean and has no in-body skip
const memberStatus = await readHarnessMemberStatus({ runChecked });

// Per-imp names need Tailscale itself, so the suite runs only on the test
// tailnet that IMP_E2E_TAILNET_NAMES=1 joins.
const tailnetNamesMissing =
  !isTailnetReady(memberStatus, probeTailscaleE2EKey()) ||
  process.env['IMP_E2E_TAILNET_NAMES'] !== '1';

test.skipIf(tailnetNamesMissing)(
  'it hands a per-imp tailnet name over with its imp: the source lets it go, the target takes it',
  async () => {
    const ctx = await setupTest();

    const named = `${ctx.prefix}n`;
    const member = readTailnetMember();
    const hosts = readMoveHosts(readMoveOptions('host-b-tailnet-names'));

    const clientB = await createInstanceClient(hosts.hostB);

    await runImp('new', named, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

    registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, named));

    await waitForExec(named);

    const live = await waitFor(
      `${named}'s tailnet name on A`,
      async () => {
        const urls = await readImpUrls(named);

        if (urls.service === null) {
          throw new Error(`${named} has no tailnet name on A yet`);
        }

        return urls.service;
      },
      { timeoutMs: 120_000 },
    );

    await runImp('stop', named);
    await runImpWith({ env: hosts.cliEnv }, 'move', named, HOST_B);

    registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(clientB, named));

    const info = await readInfo();

    expect(info.tailscale.names?.live).toBe(0);

    await runImpWith({ target: hosts.hostB }, 'start', named);

    const moved = await waitFor(
      `${named}'s tailnet name on B`,
      async () => {
        const stdout = await runImpWith({ target: hosts.hostB }, 'url', named);

        const url = findServiceUrl(stdout);

        if (url === null) {
          throw new Error(`${named} has no tailnet name on B yet`);
        }

        return url;
      },
      { timeoutMs: 180_000 },
    );

    const row = await requireImp(named, hosts.hostB);

    // Over plain HTTP: the name's certificate is B's to get.
    const body = await waitFor(
      `${moved} over the tailnet from B`,
      () => readMemberBody(member, moved.replace(/^https:/v, 'http:')),
      { timeoutMs: 180_000 },
    );

    expect(moved).toBe(live);
    expect(row.state).toBe('running');
    expect(body).toBe('e2e-tiny-ok');
  },
);
