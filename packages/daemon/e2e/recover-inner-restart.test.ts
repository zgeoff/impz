import { expect, onTestFinished, test } from 'bun:test';
import { config } from '@impz/e2e-harness/config';
import { resolveImageName } from '@impz/e2e-harness/fixtures';
import { readOkBody, readThroughProxy } from '@impz/e2e-harness/http';
import {
  createInstanceClient,
  runImp,
  runInImp,
  runShellInImp,
  startImp,
  tryImp,
} from '@impz/e2e-harness/imp-cli';
import { holdImp, readGuestFile, waitForExec, writeGuestFile } from '@impz/e2e-harness/imps';
import { readInitStart, readUptime, waitForInnerInit } from '@impz/e2e-harness/inner-container';
import { parseWholeNumber } from '@impz/e2e-harness/parse-whole-number';
import { findSocketListenAgain, parseProxyForwards } from '@impz/e2e-harness/proxy-forward-lines';
import { registerRemoval } from '@impz/e2e-harness/register-removal';
import { removeImpIfPresent } from '@impz/e2e-harness/reset-baseline';
import { getSuitePrefix } from '@impz/e2e-harness/suites';
import { startTextCapture } from '@impz/e2e-harness/text-capture';
import { waitFor } from '@impz/e2e-harness/wait-for';
import invariant from 'tiny-invariant';
import * as z from 'zod';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: getSuitePrefix('inner'), stack, client };
}

test('it starts the container again on a reboot inside, not the guest, and its service once', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}reboot`;

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'));

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);
  await writeGuestFile(name, '/root/marker', 'kept');
  await runShellInImp(name, 'rm -f /dev/null');

  const before = await readInitStart(name);
  const uptimeBefore = await readUptime(name);

  // busybox reboot -f calls reboot(2), which in a PID namespace kills its init.
  await tryImp(['exec', name, '--', 'reboot', '-f']);
  await waitForInnerInit(name);

  const after = await readInitStart(name);
  const marker = await readGuestFile(name, '/root/marker');
  const devNull = await runShellInImp(name, 'test -c /dev/null && echo back');
  const uptimeAfter = await readUptime(name);

  expect(after).not.toBe(before);
  expect(marker).toBe('kept');
  expect(devNull).toBe('back');
  expect(uptimeAfter).toBeGreaterThanOrEqual(uptimeBefore);

  // A second start would bind :8080 again, fail, and count a restart.
  const service = await waitFor(`www running in ${name} after the restart`, async () => {
    const listed = await runImp('service', 'ls', name, '--json');

    const found = z
      .array(
        z.object({
          name: z.string(),
          state: z.string(),
          pid: z.number().nullable(),
          restarts: z.number(),
        }),
      )
      .parse(JSON.parse(listed))
      .find((candidate) => candidate.name === 'www');

    if (found?.state !== 'running') {
      throw new Error(`www is ${found?.state ?? 'not listed'}`);
    }

    return found;
  });

  const pids = await runShellInImp(name, 'pidof httpd || true');

  expect(service.restarts).toBe(0);
  expect(pids.split(' ')).toStrictEqual([String(service.pid)]);
});

test('it keeps forwards, reverse forwards and the service port working through a restart inside', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}fwd`;

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'));

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const page = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    routes: { '/*': () => new Response('e2e-inner-reverse\n') },
  });

  ctx.stack.defer(() => page.stop(true));

  const pagePort = String(page.port);

  const proxy = await startImp([
    'proxy',
    name,
    '0:8080',
    '--reverse',
    `0:${pagePort}`,
    '--reverse',
    `:${pagePort}`,
  ]);

  ctx.stack.defer(async () => {
    proxy.kill('SIGINT');

    await proxy.exited;
  });

  const stdout = startTextCapture(proxy.stdout);
  const stderr = startTextCapture(proxy.stderr);

  const forwards = await waitFor('impz proxy to listen', () => {
    const parsed = parseProxyForwards(stdout.read());

    if (
      parsed.localPort === undefined ||
      parsed.guestPort === undefined ||
      parsed.socketPath === undefined
    ) {
      throw new Error(`impz proxy printed ${stdout.read()}${stderr.read()}`);
    }

    return parsed;
  });

  invariant(forwards.localPort !== undefined);
  invariant(forwards.guestPort !== undefined);

  const local = `http://127.0.0.1:${forwards.localPort}/`;
  const fetchInGuest = `wget -qO- http://127.0.0.1:${forwards.guestPort}/`;

  const before = await readOkBody(fetch(local));
  const reversedBefore = await runShellInImp(name, fetchInGuest);

  expect(before).toBe('e2e-tiny-ok');
  expect(reversedBefore).toBe('e2e-inner-reverse');

  await tryImp(['exec', name, '--', 'reboot', '-f']);
  await waitForInnerInit(name);

  const after = await waitFor('the forward to the service after the restart', () =>
    readOkBody(fetch(local)),
  );

  const reversedAfter = await runShellInImp(name, fetchInGuest);

  const again = await waitFor('the reverse forward on a socket to listen again', () => {
    const path = findSocketListenAgain(stderr.read());

    if (path === undefined) {
      throw new Error(`impz proxy said ${stderr.read()}`);
    }

    return path;
  });

  const exists = await runShellInImp(name, `test -S '${again}' && echo socket`);
  const throughProxy = await readThroughProxy(name);

  expect(after).toBe('e2e-tiny-ok');
  expect(reversedAfter).toBe('e2e-inner-reverse');
  expect(exists).toBe('socket');
  expect(throughProxy).toBe('e2e-tiny-ok');
});

test('it starts a container whose root was wiped again', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}wiped`;
  const keep = '/keep/busybox';

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'));

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const before = await readInitStart(name);

  await runShellInImp(name, `mkdir /keep && cp /bin/busybox ${keep}`);

  await tryImp([
    'exec',
    name,
    '--',
    'sh',
    '-c',
    `for f in /*; do case $f in /keep|/lib|/lib64) ;; *) ${keep} rm -rf "$f" ;; esac; done 2>/dev/null; ${keep} reboot -f`,
  ]);

  const after = await waitFor(`the inner container in ${name} after the wipe`, async () => {
    const stat = await runInImp(name, keep, 'cat', '/proc/1/stat');

    const start = parseWholeNumber(stat.split(' ').at(21) ?? '', `${name}'s init start`);

    if (start === before) {
      throw new Error('the old container still runs');
    }

    return start;
  });

  const listed = await runInImp(name, keep, 'ls', '/');
  const broken = await tryImp(['exec', name, '--', 'true']);

  expect(after).not.toBe(before);
  expect(listed.split('\n')).toIncludeAllMembers(['keep', 'proc', 'run']);

  expect(broken).toStrictEqual({
    exitCode: 127,
    stdout: '',
    stderr: expect.toInclude('EXEC_FAILED'),
  });
});
