import { expect, onTestFinished, test } from 'bun:test';
import { config } from '@impz/e2e-harness/config';
import { resolveImageName } from '@impz/e2e-harness/fixtures';
import {
  assertState,
  createInstanceClient,
  readImp,
  requireImp,
  runImp,
  runImpWith,
} from '@impz/e2e-harness/imp-cli';
import { holdImp, waitForExec } from '@impz/e2e-harness/imps';
import { HOST_B, readMoveHosts } from '@impz/e2e-harness/move-hosts';
import { readJailOwners } from '@impz/e2e-harness/move-steps';
import { registerRemoval } from '@impz/e2e-harness/register-removal';
import { removeImpIfPresent } from '@impz/e2e-harness/reset-baseline';
import { getSuitePrefix } from '@impz/e2e-harness/suites';
import { waitFor } from '@impz/e2e-harness/wait-for';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const hosts = readMoveHosts({ tailnet: 'off' });

  const client = await createInstanceClient();
  const clientB = await createInstanceClient(hosts.hostB);

  return { prefix: getSuitePrefix('moves'), stack, hosts, client, clientB };
}

test('it moves a sleeping open imp with its memory, and it reaches out at once on the target', async () => {
  const ctx = await setupTest();

  const open = `${ctx.prefix}open`;

  await runImp('new', open, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, open));

  await waitForExec(open);
  await holdImp(open);

  await runImp(
    'exec',
    open,
    '--',
    'sh',
    '-c',
    'echo warm-ok > /dev/shm/mark && (sleep 100000 >/dev/null 2>&1 &) && sync',
  );

  // The sleeper's pid comes first, older than the shell that runs pgrep.
  const pids = await runImp('exec', open, '--', 'sh', '-c', "pgrep -f 'sleep 100000' || true");

  const [pid = ''] = pids.split('\n');

  expect(pid).not.toBe('');

  await runImp('hold', open, '0');
  await runImp('sleep', open);
  await waitFor(`${open} to sleep`, () => assertState(open, 'sleeping'));

  const out = await runImpWith({ env: ctx.hosts.cliEnv }, 'move', open, HOST_B);

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.clientB, open));

  const left = await readImp(open);
  const moved = await requireImp(open, ctx.hosts.hostB);

  expect(out).toContain(`${open}: moved to ${HOST_B}, asleep with its memory`);
  expect(left).toBeUndefined();
  expect(moved.state).toBe('sleeping');

  const onB = { target: ctx.hosts.hostB };

  const mark = await runImpWith(onB, 'exec', open, '--', 'cat', '/dev/shm/mark');

  const pidsAfter = await runImpWith(
    onB,
    'exec',
    open,
    '--',
    'sh',
    '-c',
    "pgrep -f 'sleep 100000' || true",
  );

  const [after = ''] = pidsAfter.split('\n');

  const lookup = await runImpWith(
    onB,
    'exec',
    open,
    '--',
    'sh',
    '-c',
    'nslookup example.com >/dev/null && echo dns-ok',
  );

  const fetched = await runImpWith(
    onB,
    'exec',
    open,
    '--',
    'sh',
    '-c',
    'wget -q -T 10 -O /dev/null http://example.com/ && echo http-ok',
  );

  const row = await requireImp(open, ctx.hosts.hostB);
  const owners = await readJailOwners(ctx.hosts.hostB, row.id, row.slot);

  const [uid = ''] = owners;

  expect(mark).toBe('warm-ok\n');
  expect(after).toBe(pid);
  expect(lookup).toBe('dns-ok\n');
  expect(fetched).toBe('http-ok\n');
  expect(row.coldBootReason).toBeUndefined();
  expect(Number(uid)).toBeGreaterThanOrEqual(900_000);
  expect(owners).toStrictEqual([uid, uid, uid]);
});
