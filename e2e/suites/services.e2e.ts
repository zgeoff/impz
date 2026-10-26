import { expect, onTestFinished, test } from 'bun:test';
import { config } from '@impz/e2e-harness/config';
import { resolveImageName } from '@impz/e2e-harness/fixtures';
import { readThroughProxy, sendProxyRequest } from '@impz/e2e-harness/http';
import {
  createInstanceClient,
  readState,
  requireImp,
  runImp,
  runInImp,
  runShellInImp,
  startImp,
  tryImp,
} from '@impz/e2e-harness/imp-cli';
import { readText } from '@impz/e2e-harness/imp-proxy';
import { waitForExec } from '@impz/e2e-harness/imps';
import { registerRemoval } from '@impz/e2e-harness/register-removal';
import { removeImpIfPresent } from '@impz/e2e-harness/reset-baseline';
import { listServices, waitForServicePid } from '@impz/e2e-harness/services';
import { getSuitePrefix } from '@impz/e2e-harness/suites';
import { waitFor } from '@impz/e2e-harness/wait-for';
import invariant from 'tiny-invariant';

// One stack for every release, so a follow stops before its imp goes.
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: getSuitePrefix('services'), stack, client };
}

test('it runs an added service through logs, a restart, a sleep, a reboot and a remove', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}life`;

  await runImp('new', name, '--image', resolveImageName('e2e-bare'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await runShellInImp(name, 'mkdir -p /srv/www && echo hello from a service > /srv/www/index.html');

  await runImp(
    'service',
    'add',
    name,
    'web',
    '--env',
    'GREETING=hi',
    '--',
    'busybox',
    'httpd',
    '-f',
    '-vv',
    '-p',
    '8080',
    '-h',
    '/srv/www',
  );

  const firstPid = await waitForServicePid(name, 'web', null);
  const body = await waitFor('the service to answer', () => readThroughProxy(name));
  const file = await runInImp(name, 'cat', '/etc/imp/services.d/web.json');
  const added = await listServices(name);

  const written: unknown = JSON.parse(file);

  expect(body).toBe('hello from a service');
  expect(written).toMatchObject({ env: ['GREETING=hi'], source: 'api' });
  expect(written).not.toHaveProperty('name');

  expect(added).toStrictEqual([
    {
      name: 'web',
      state: 'running',
      pid: firstPid,
      argv: ['busybox', 'httpd', '-f', '-vv', '-p', '8080', '-h', '/srv/www'],
      envKeys: ['GREETING'],
      source: 'api',
      root: true,
    },
  ]);

  const logs = await runImp('logs', name, 'web');
  const follow = await startImp(['logs', name, 'web', '-f', '-n', '0']);

  ctx.stack.defer(async () => {
    follow.kill();

    await follow.exited;
  });

  const followed = readText(follow.stdout);
  const marker = `/followed-${String(Date.now())}`;

  // A request before the follow starts may land in the tail it skips, so the
  // request goes again until one shows.
  await waitFor('the follow to print a request', async () => {
    await sendProxyRequest(name, marker);

    if (!followed.read().includes(marker)) {
      throw new Error(`printed so far: ${JSON.stringify(followed.read())}`);
    }
  });

  follow.kill();

  await follow.exited;

  const all = await runImp('logs', name);

  expect(logs).toContain(': GET /');
  expect(all).toMatch(/^web \| /mu);

  await runImp('service', 'restart', name, 'web');

  const restartedPid = await waitForServicePid(name, 'web', firstPid);
  const restarted = await readThroughProxy(name);

  expect(restarted).toBe('hello from a service');

  await runImp('sleep', name);

  const asleep = await listServices(name);
  const asleepState = await readState(name);
  const woken = await readThroughProxy(name);
  const awake = await listServices(name);

  expect(asleep.map((service) => [service.name, service.pid])).toStrictEqual([
    ['web', restartedPid],
  ]);

  expect(asleepState).toBe('sleeping');
  expect(woken).toBe('hello from a service');
  expect(awake[0]?.pid).toBe(restartedPid);

  await runImp('stop', name);
  await runImp('start', name);
  await waitForServicePid(name, 'web', null);

  const rebooted = await waitFor('the service after a reboot', () => readThroughProxy(name));

  expect(rebooted).toBe('hello from a service');

  await runImp('service', 'rm', name, 'web');

  const removed = await listServices(name);
  const files = await runInImp(name, 'ls', '/etc/imp/services.d');
  const response = await sendProxyRequest(name);
  const kept = await runImp('logs', name, 'web');
  const again = await tryImp(['service', 'rm', name, 'web']);

  expect(removed).toStrictEqual([]);
  expect(files).toBe('');
  expect(response.ok).toBe(false);
  expect(kept).toContain(': GET /');

  expect(again).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toInclude('not found'),
  });
});

test('it waits out a sleep in a log follow without waking the imp, and prints each line once', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}follow`;

  await runImp('new', name, '--image', resolveImageName('e2e-bare'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await runShellInImp(name, 'mkdir -p /srv/www && echo hello from a service > /srv/www/index.html');

  await runImp(
    'service',
    'add',
    name,
    'web',
    '--',
    'busybox',
    'httpd',
    '-f',
    '-vv',
    '-p',
    '8080',
    '-h',
    '/srv/www',
  );

  await waitForServicePid(name, 'web', null);

  const follow = await startImp(['logs', name, 'web', '-f', '-n', '0']);

  ctx.stack.defer(async () => {
    follow.kill();

    await follow.exited;
  });

  const stdout = readText(follow.stdout);
  const stderr = readText(follow.stderr);
  const opened = `/opened-${String(Date.now())}`;

  await waitFor('the follow to print a request', async () => {
    await sendProxyRequest(name, opened);

    if (!stdout.read().includes(opened)) {
      throw new Error(`printed so far: ${JSON.stringify(stdout.read())}`);
    }
  });

  await runImp('sleep', name);

  const slept = await requireImp(name);

  await waitFor('the follow to say the imp sleeps', () => {
    if (!stderr.read().includes(`${name} is sleeping`)) {
      throw new Error(`the follow said ${JSON.stringify(stderr.read())}`);
    }
  });

  // The dwell's length is the contract: it outlasts impd's follow recheck, so
  // a read would have woken the imp by now.
  await Bun.sleep(6000);

  const waiting = await requireImp(name);

  const saidBeforeWake = stderr.read();
  const marker = `/after-sleep-${String(Date.now())}`;

  await sendProxyRequest(name, marker);

  await waitFor('the follow to print the request after the wake', () => {
    if (!stdout.read().includes(`: GET ${marker}`)) {
      throw new Error(`printed so far: ${JSON.stringify(stdout.read())}`);
    }
  });

  invariant(slept.resources);
  invariant(waiting.resources);

  expect(slept.state).toBe('sleeping');
  expect(waiting.state).toBe('sleeping');
  expect(waiting.resources.wakeCount).toBe(slept.resources.wakeCount);
  expect(saidBeforeWake).not.toContain(`${name} runs again`);
  expect(stderr.read()).toContain(`${name} runs again`);
  expect(stdout.read().split(`: GET ${marker}`)).toHaveLength(2);
});

test('it starts a service file written by hand on its first restart', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}late`;

  await runImp('new', name, '--image', resolveImageName('e2e-bare'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  await runShellInImp(
    name,
    `mkdir -p /etc/imp/services.d && echo '{"argv":["sleep","3600"]}' > /etc/imp/services.d/late.json`,
  );

  await runImp('service', 'restart', name, 'late');

  const late = await waitFor('the late service to run', async () => {
    const services = await listServices(name);

    const found = services.find((service) => service.name === 'late');

    if (found?.state !== 'running') {
      throw new Error(JSON.stringify(services));
    }

    return found;
  });

  expect(late.argv).toStrictEqual(['sleep', '3600']);
});

test('it points the imp URL at a service added with --http-port, and back once it is set again', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}port`;

  await runImp('new', name, '--image', resolveImageName('e2e-bare'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  await runShellInImp(
    name,
    'mkdir -p /srv/www /srv/alt && echo hello from a service > /srv/www/index.html && echo hello from alt > /srv/alt/index.html',
  );

  await runImp('service', 'add', name, 'web', '--cmd', 'busybox httpd -f -p 8080 -h /srv/www');
  await waitFor('the service on 8080 to answer', () => readThroughProxy(name));

  await runImp(
    'service',
    'add',
    name,
    'alt',
    '--http-port',
    '8081',
    '--cmd',
    'busybox httpd -f -p 8081 -h /srv/alt',
  );

  const body = await waitFor('the proxy to reach port 8081', async () => {
    const text = await readThroughProxy(name);

    if (text !== 'hello from alt') {
      throw new Error(`the imp URL answered ${text}`);
    }

    return text;
  });

  await runImp('set', name, '--http-port', '8080');
  await runImp('service', 'rm', name, 'alt');

  const back = await readThroughProxy(name);

  expect(body).toBe('hello from alt');
  expect(back).toBe('hello from a service');
});
