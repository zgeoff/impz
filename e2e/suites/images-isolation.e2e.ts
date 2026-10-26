import { expect, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeBuildContext } from '@impz/e2e-harness/build-context';
import { buildReachScript } from '@impz/e2e-harness/build-reach-script';
import { config } from '@impz/e2e-harness/config';
import { createInstanceClient, runImp, runInImp } from '@impz/e2e-harness/imp-cli';
import { waitForExec } from '@impz/e2e-harness/imps';
import { parseInet6Addresses } from '@impz/e2e-harness/inet6-addresses';
import {
  REPO_ROOT,
  readContainerGateway,
  runChecked,
  runCommand,
  runInContainer,
} from '@impz/e2e-harness/instance';
import { registerRemoval } from '@impz/e2e-harness/register-removal';
import { removeImageIfPresent, removeImpIfPresent } from '@impz/e2e-harness/reset-baseline';
import { getSuitePrefix } from '@impz/e2e-harness/suites';
import { waitFor } from '@impz/e2e-harness/wait-for';
import * as z from 'zod';

// collection-time gate: Bun's skipIf takes a boolean and has no in-body skip
const route6 = await runInContainer(['ip', '-6', 'route', 'show', 'default']);

// The public IPv6 fetch needs an IPv6 default route in the host container.
const ipv6RouteMissing = route6.stdout.trim() === '';

// One stack for every release, so each imp goes before the image it boots.
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  await mkdir(join(REPO_ROOT, '.cache', 'e2e'), { recursive: true });

  const buildRoot = await mkdtemp(join(REPO_ROOT, '.cache', 'e2e', 'build-'));

  stack.defer(() => rm(buildRoot, { recursive: true, force: true }));

  return { prefix: getSuitePrefix('images'), stack, client, buildRoot };
}

test('it lets an isolated build reach the internet but not the host, impd or a private address, and removes its builder', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}iso`;
  const requests: string[] = [];

  const handleListenerRequest = (request: Request) => {
    requests.push(request.url);

    return new Response('probe');
  };

  const listener = Bun.serve({
    hostname: '0.0.0.0',
    port: 0,
    fetch: handleListenerRequest,
  });

  ctx.stack.defer(() => listener.stop(true));

  const gateway = await readContainerGateway();

  const targets = [`${gateway}:${String(listener.port)}`, '10.66.0.1:7070', '169.254.169.254:80'];

  const directory = await writeBuildContext(
    ctx.buildRoot,
    'isolation',
    [
      'FROM busybox:1.37',
      `RUN for t in ${targets.join(' ')}; do \\`,
      '      if wget -T 3 -q -O /dev/null "http://$t/"; then echo "$t open"; else echo "$t closed"; fi; \\',
      '    done > /probe.txt; \\',
      `    if (${buildReachScript('http://example.com/', 15)}) 2>/dev/null; then echo "public open"; else echo "public closed"; fi >> /probe.txt`,
      '',
    ].join('\n'),
  );

  await runImp('image', 'build', directory, '--name', name);

  registerRemoval(ctx.stack, config.keep, () => removeImageIfPresent(ctx.client, name));

  await runImp('new', name, '--image', name);

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const probe = await runInImp(name, 'cat', '/probe.txt');
  const listedJson = await runImp('ls', '--builders', '--json');

  const listed: unknown = JSON.parse(listedJson);
  const kinds = z.array(z.object({ kind: z.string().optional() })).parse(listed);

  expect(probe.split('\n')).toStrictEqual([
    `${gateway}:${String(listener.port)} closed`,
    '10.66.0.1:7070 closed',
    '169.254.169.254:80 closed',
    'public open',
  ]);

  expect(requests).toStrictEqual([]);
  expect(kinds.filter((imp) => imp.kind === 'builder')).toStrictEqual([]);
});

test("it lets an isolated build's broker tunnel reach the internet, but not the host, its taps or impd", async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}broker`;
  const requests: string[] = [];

  const handleListenerRequest = (request: Request) => {
    requests.push(request.url);

    return new Response('probe');
  };

  const listener = Bun.serve({
    hostname: '0.0.0.0',
    port: 0,
    fetch: handleListenerRequest,
  });

  ctx.stack.defer(() => listener.stop(true));

  const gateway = await readContainerGateway();
  const shown = await runInContainer(['ip', '-6', '-o', 'addr', 'show']);

  const own6 = parseInet6Addresses(shown.stdout).map((address) => `[${address}]:7070`);

  const refused = [
    `${gateway}:${String(listener.port)}`,
    '10.66.0.1:7070',
    'GW:7070',
    '127.0.0.1:7070',
    '[::1]:7070',
    '[fe80::1]:7070',
    '169.254.169.254:80',
    ...own6,
  ];

  const directory = await writeBuildContext(
    ctx.buildRoot,
    'broker',
    [
      'FROM busybox:1.37',
      "RUN gw=$(traceroute -n -m 2 -w 2 1.1.1.1 2>/dev/null | awk '$1 == 2 { print $2 }'); \\",
      '    awk \'$6 != "lo" { print "ipv6 " $6 }\' /proc/net/if_inet6 > /probe.txt; \\',
      '    if wget -T 3 -q -O /dev/null "http://$gw:7070/"; then echo "direct open"; else echo "direct closed"; fi >> /probe.txt; \\',
      `    for t in ${[...refused, 'example.com:80'].join(' ')}; do \\`,
      '      d=$(echo "$t" | sed "s/^GW:/$gw:/"); \\',
      '      reply=$( (printf \'CONNECT %s HTTP/1.1\\r\\nHost: %s\\r\\n\\r\\n\' "$d" "$d"; sleep 3) | nc -w 5 "$gw" 7081 | head -1 | cut -d \' \' -f 2); \\',
      '      echo "$t $reply"; \\',
      '    done >> /probe.txt',
      '',
    ].join('\n'),
  );

  await runImp('image', 'build', directory, '--name', name);

  registerRemoval(ctx.stack, config.keep, () => removeImageIfPresent(ctx.client, name));

  await runImp('new', name, '--image', name);

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const probe = await runInImp(name, 'cat', '/probe.txt');

  expect(probe.split('\n')).toStrictEqual([
    'direct closed',
    ...refused.map((target) => `${target} 403`),
    'example.com:80 200',
  ]);

  expect(requests).toStrictEqual([]);
});

test.skipIf(ipv6RouteMissing)(
  "it lets an isolated build's broker tunnel reach a public IPv6 address",
  async () => {
    const ctx = await setupTest();

    const name = `${ctx.prefix}broker6`;

    const directory = await writeBuildContext(
      ctx.buildRoot,
      'broker6',
      [
        'FROM busybox:1.37',
        "RUN gw=$(traceroute -n -m 2 -w 2 1.1.1.1 2>/dev/null | awk '$1 == 2 { print $2 }'); \\",
        '    t=[2606:4700:4700::1111]:80; \\',
        '    reply=$( (printf \'CONNECT %s HTTP/1.1\\r\\nHost: %s\\r\\n\\r\\n\' "$t" "$t"; sleep 3) | nc -w 5 "$gw" 7081 | head -1 | cut -d \' \' -f 2); \\',
        '    echo "$t $reply" > /probe.txt',
        '',
      ].join('\n'),
    );

    await runImp('image', 'build', directory, '--name', name);

    registerRemoval(ctx.stack, config.keep, () => removeImageIfPresent(ctx.client, name));

    await runImp('new', name, '--image', name);

    registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

    await waitForExec(name);

    const probe = await runInImp(name, 'cat', '/probe.txt');

    expect(probe).toBe('[2606:4700:4700::1111]:80 200');
  },
);

test('it pulls an added image in a builder: the host engine gains no image, the audit log names the digest, and the image boots', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}added`;

  // Other work on this engine may change other repositories meanwhile.
  const busyboxArgv = [
    'docker',
    'image',
    'ls',
    '--all',
    '--digests',
    '--no-trunc',
    '--format',
    '{{.Repository}}:{{.Tag}}@{{.Digest}} {{.ID}}',
    'busybox',
  ];

  const before = await runChecked(busyboxArgv);

  await runImp('image', 'add', 'busybox:1.36.1', '--name', name);

  registerRemoval(ctx.stack, config.keep, () => removeImageIfPresent(ctx.client, name));

  const after = await runChecked(busyboxArgv);
  const inspected = await runCommand(['docker', 'image', 'inspect', 'busybox:1.36.1']);

  expect(after.split('\n').toSorted()).toStrictEqual(before.split('\n').toSorted());

  expect(inspected).toStrictEqual({
    exitCode: 1,
    stdout: '[]\n',
    stderr: expect.toInclude('No such image: busybox:1.36.1'),
  });

  // impd writes the audit row after the answer.
  const add = await waitFor('the add in the audit log', async () => {
    const auditJson = await runImp('audit', '--kind', 'api', '--json', '--limit', '20');

    const audit: unknown = JSON.parse(auditJson);

    const found = z
      .array(z.object({ procedure: z.string(), detail: z.string().optional() }))
      .parse(audit)
      .find((call) => call.procedure === 'images.add' || call.procedure === 'images.addStream');

    if (found === undefined) {
      throw new Error('no images.add row yet');
    }

    return found;
  });

  expect(add.detail).toMatch(/^busybox@sha256:[a-f0-9]{64}$/v);

  await runImp('new', name, '--image', name);

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const banner = await runInImp(name, 'busybox');

  expect(banner).toContain('BusyBox v1.36.1');

  await runImp('rm', name);
  await runImp('image', 'rm', name);

  const listedJson = await runImp('ls', '--builders', '--json');

  const listed: unknown = JSON.parse(listedJson);
  const kinds = z.array(z.object({ kind: z.string().optional() })).parse(listed);

  expect(kinds.filter((imp) => imp.kind === 'builder')).toStrictEqual([]);
});
