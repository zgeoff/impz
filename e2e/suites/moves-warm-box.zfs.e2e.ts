import { expect, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
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
import { buildUpstreamsPath, readAllowSet, writeUpstreamsFile } from '@impz/e2e-harness/move-steps';
import { registerRemoval } from '@impz/e2e-harness/register-removal';
import { removeImpIfPresent, removeSecretIfPresent } from '@impz/e2e-harness/reset-baseline';
import { startStubUpstream } from '@impz/e2e-harness/start-stub-upstream';
import { getSuitePrefix } from '@impz/e2e-harness/suites';
import { waitFor } from '@impz/e2e-harness/wait-for';

// The stub upstream for api.github.com checks B's token, so it tells which
// broker sent a call.

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const hosts = readMoveHosts({ tailnet: 'off' });

  const client = await createInstanceClient();
  const clientB = await createInstanceClient(hosts.hostB);

  return { prefix: getSuitePrefix('moves'), stack, hosts, client, clientB };
}

test('it moves a sleeping box imp with its allow list, and the target’s broker answers right after the wake', async () => {
  const ctx = await setupTest();

  const box = `${ctx.prefix}box`;
  const secret = `${ctx.prefix}gh`;
  const tokenA = `e2e-a-${randomUUID()}`;
  const tokenB = `e2e-b-${randomUUID()}`;

  const upstream = await startStubUpstream(ctx.hosts.gateway, tokenB);

  ctx.stack.defer(() => upstream.stop());

  await writeUpstreamsFile(ctx.hosts.hostA, upstream);

  ctx.stack.defer(() => rm(buildUpstreamsPath(ctx.hosts.hostA), { force: true }));

  await writeUpstreamsFile(ctx.hosts.hostB, upstream);

  ctx.stack.defer(() => rm(buildUpstreamsPath(ctx.hosts.hostB), { force: true }));

  await runImpWith({ stdin: `${tokenA}\n` }, 'secret', 'add', secret, '--kind', 'github');

  registerRemoval(ctx.stack, config.keep, () => removeSecretIfPresent(ctx.client, secret));

  await runImpWith(
    { target: ctx.hosts.hostB, stdin: `${tokenB}\n` },
    'secret',
    'add',
    secret,
    '--kind',
    'github',
  );

  registerRemoval(ctx.stack, config.keep, () => removeSecretIfPresent(ctx.clientB, secret));

  await runImp(
    'new',
    box,
    '--image',
    resolveImageName('base'),
    '--memory',
    '1g',
    '--policy',
    'box',
    '--allow',

    // B resolves only the exact names at create, so a wildcard's addresses on B
    // can only have come from A's lookups.
    'example.com,api.github.com,github.com,*.wikipedia.org',
  );

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, box));

  await waitForExec(box);
  await runImp('grant', box, secret);
  await holdImp(box);

  await runImp(
    'exec',
    box,
    '--',
    'sh',
    '-c',
    'echo warm-ok > /dev/shm/mark && (sleep 100000 >/dev/null 2>&1 &) && sync',
  );

  // The sleeper's pid comes first, older than the shell that runs pgrep.
  const pids = await runImp('exec', box, '--', 'sh', '-c', "pgrep -f 'sleep 100000' || true");

  const [pid = ''] = pids.split('\n');

  // A lookup on A under the wildcard, whose answer only the move can carry
  // into B's set for the slot.
  await runImp('exec', box, '--', 'getent', 'hosts', 'en.wikipedia.org');

  const onA = await requireImp(box);
  const before = await readAllowSet(ctx.hosts.hostA, onA.slot);

  await runImp('hold', box, '0');
  await runImp('sleep', box);
  await waitFor(`${box} to sleep`, () => assertState(box, 'sleeping'));

  const out = await runImpWith({ env: ctx.hosts.cliEnv }, 'move', box, HOST_B);

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.clientB, box));

  const left = await readImp(box);
  const moved = await requireImp(box, ctx.hosts.hostB);

  expect(pid).not.toBe('');
  expect(out).toContain(`${box}: moved to ${HOST_B}, asleep with its memory`);
  expect(left).toBeUndefined();
  expect(moved.state).toBe('sleeping');

  // Read before the guest can look anything up again on B.
  const held = await readAllowSet(ctx.hosts.hostB, onA.slot);

  // The broker call first: the target installs its CA at the first wake.
  const onB = { target: ctx.hosts.hostB };

  const body = await runImpWith(
    onB,
    'exec',
    box,
    '--',
    'curl',
    '-sS',
    '--fail',
    'https://api.github.com/user',
  );

  const mark = await runImpWith(onB, 'exec', box, '--', 'cat', '/dev/shm/mark');

  const pidsAfter = await runImpWith(
    onB,
    'exec',
    box,
    '--',
    'sh',
    '-c',
    "pgrep -f 'sleep 100000' || true",
  );

  const [after = ''] = pidsAfter.split('\n');

  const allowed = await runImpWith(
    onB,
    'exec',
    box,
    '--',
    'curl',
    '-sS',
    '-o',
    '/dev/null',
    '-w',
    '%{http_code}',
    '--max-time',
    '10',
    'http://example.com/',
  );

  const refused = await runImpWith(
    onB,
    'exec',
    box,
    '--',
    'sh',
    '-c',
    'curl -s -o /dev/null -w "%{http_code}" --max-time 10 http://example.org/ || true',
  );

  expect(before).not.toBeEmpty();
  expect(held).toIncludeAllMembers(before);
  expect(JSON.parse(body)).toStrictEqual({ authorized: true });
  expect(upstream.seen.at(-1)?.authorization).toBe(`Bearer ${tokenB}`);
  expect(mark).toBe('warm-ok\n');
  expect(after).toBe(pid);
  expect(allowed).toBe('200');
  expect(refused).toBe('000');
});
