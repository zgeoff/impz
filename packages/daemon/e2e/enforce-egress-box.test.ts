import { expect, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { config } from '@impz/e2e-harness/config';
import { buildTcpQueryOctal, parseTcpReplyHex } from '@impz/e2e-harness/dns-probe';
import { resolveImageName } from '@impz/e2e-harness/fixtures';
import { tryDialFromImp, tryGetFromImp, tryInImp } from '@impz/e2e-harness/guest-probe';
import { createInstanceClient, requireImp, runImp, runShellInImp } from '@impz/e2e-harness/imp-cli';
import { startReverse } from '@impz/e2e-harness/imp-proxy';
import { holdImp, waitForExec } from '@impz/e2e-harness/imps';
import { readContainerGateway, runInContainer } from '@impz/e2e-harness/instance';
import { parseWholeNumber } from '@impz/e2e-harness/parse-whole-number';
import { registerRemoval } from '@impz/e2e-harness/register-removal';
import { removeImpIfPresent, removeSecretIfPresent } from '@impz/e2e-harness/reset-baseline';
import { startStubPrivateService } from '@impz/e2e-harness/start-stub-private-service';
import { getSuitePrefix } from '@impz/e2e-harness/suites';
import { waitForTailnetIp } from '@impz/e2e-harness/tailnet';
import { waitFor } from '@impz/e2e-harness/wait-for';
import { writeMetric } from '@impz/e2e-harness/write-metric';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();
  const gateway = await readContainerGateway();

  return { prefix: getSuitePrefix('egress'), stack, client, gateway };
}

test('it lets an open imp reach the internet and the private gateway, and no imp the metadata service', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}open`;
  const listener = startStubPrivateService(ctx.gateway);

  ctx.stack.defer(() => {
    listener.stop();
  });

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const exampleCom = await tryGetFromImp(name, 'http://example.com/');
  const exampleOrg = await tryGetFromImp(name, 'http://example.org/');
  const gateway = await tryDialFromImp(name, ctx.gateway, listener.port);
  const metadata = await tryDialFromImp(name, '169.254.169.254', 80);

  expect(exampleCom).toBeTrue();
  expect(exampleOrg).toBeTrue();
  expect(gateway).toBeTrue();
  expect(metadata).toBeFalse();
});

test('it lets a box imp reach its list, and nothing else', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}box`;
  const listener = startStubPrivateService(ctx.gateway);

  ctx.stack.defer(() => {
    listener.stop();
  });

  await runImp(
    'new',
    name,
    '--image',
    resolveImageName('e2e-tiny'),
    '--memory',
    '256',
    '--policy',
    'box',
    '--allow',
    'example.com',
  );

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const started = performance.now();

  const allowed = await tryGetFromImp(name, 'http://example.com/');

  writeMetric('egressFirstFetchMs', Math.round(performance.now() - started));

  const unlisted = await tryGetFromImp(name, 'http://example.org/');
  const unnamed = await tryDialFromImp(name, '9.9.9.9', 443);
  const gateway = await tryDialFromImp(name, ctx.gateway, listener.port);

  expect(allowed).toBeTrue();
  expect(unlisted).toBeFalse();
  expect(unnamed).toBeFalse();
  expect(gateway).toBeFalse();
});

test('it answers a refused name with REFUSED and EDE 18, whichever resolver the guest asks', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}dns`;

  await runImp(
    'new',
    name,
    '--image',
    resolveImageName('e2e-tiny'),
    '--memory',
    '256',
    '--policy',
    'box',
    '--allow',
    'example.com',
  );

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  // Over TCP, which busybox's nc speaks: a length, then the message.
  const hex = await runShellInImp(
    name,
    `printf '${buildTcpQueryOctal('example.org')}' | nc -w 3 8.8.8.8 53 | od -An -tx1 -v`,
  );

  const parsed = parseTcpReplyHex(hex);

  expect(parsed.reply).toMatchObject({ rcode: 'REFUSED', answers: [] });
  expect(parsed.lastOption).toStrictEqual([15, 18]);
});

test('it drops a guest that sends from another address of its /30', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}spoof`;
  const listener = startStubPrivateService(ctx.gateway);

  ctx.stack.defer(() => {
    listener.stop();
  });

  await runImp(
    'new',
    name,
    '--image',
    resolveImageName('e2e-tiny'),
    '--memory',
    '256',
    '--policy',
    'box',
    '--allow',
    `example.com,${ctx.gateway}/32`,
  );

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const row = await requireImp(name);

  const octets = row.ip.split('.').map(Number);

  // The /30's network address, which the tap's reverse-path check passes.
  const other = [...octets.slice(0, 3), (octets[3] ?? 0) - 2].join('.');

  await runShellInImp(name, `ip addr add ${other}/32 dev eth0`);

  const fromGuest = await tryDialFromImp(name, ctx.gateway, listener.port);
  const fromOther = await tryDialFromImp(name, ctx.gateway, listener.port, other);

  expect(fromGuest).toBeTrue();
  expect(fromOther).toBeFalse();
});

test('it opens a private address only by an explicit CIDR, and cuts its flow under a tighter policy', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}cidr`;
  const listener = startStubPrivateService(ctx.gateway);

  ctx.stack.defer(() => {
    listener.stop();
  });

  await runImp(
    'new',
    name,
    '--image',
    resolveImageName('e2e-tiny'),
    '--memory',
    '256',
    '--policy',
    'box',
    '--allow',
    `example.com,${ctx.gateway}/32`,
  );

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  await runShellInImp(
    name,
    `rm -f /tmp/nc-done; setsid sh -c '(while sleep 0.2; do echo x; done | nc ${ctx.gateway} ${String(listener.port)}; echo done > /tmp/nc-done)' </dev/null >/dev/null 2>&1 &`,
  );

  await waitFor('the held flow to carry data', () => {
    if (listener.readReceived() <= 10) {
      throw new Error(`${String(listener.readReceived())} bytes so far`);
    }
  });

  await runImp('policy', name, 'box', '--allow', 'example.com');

  const ended = await waitFor('the guest to see its flow end', async () => {
    const done = await tryInImp(name, 'test -f /tmp/nc-done');

    if (!done) {
      throw new Error('the flow is still open');
    }

    return done;
  });

  const policy = await runImp('policy', name);

  expect(ended).toBeTrue();
  expect(policy.trim()).toBe('box: example.com');
});

test('it ends the broker tunnels a tighter policy denies, even one whose head comes after it', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}tun`;

  await runImp(
    'new',
    name,
    '--image',
    resolveImageName('e2e-tiny'),
    '--memory',
    '256',
    '--policy',
    'box',
    '--allow',
    'example.com,example.org',
  );

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const route = await runShellInImp(name, 'ip -4 route show default');

  const gateway = /via (?<ip>[\d.]+)/v.exec(route)?.groups?.['ip'] ?? '';
  const broker = `${gateway} 7081`;
  const head = String.raw`CONNECT example.org:80 HTTP/1.1\r\nHost: example.org:80\r\n\r\n`;

  // A header with no end holds the tunnel open: garbage instead would get a 400
  // from example.org, which closes it first.
  const hold = String.raw`GET / HTTP/1.1\r\nHost: example.org\r\nX-Hold: `;

  await runShellInImp(
    name,
    `rm -f /tmp/tun-*; setsid sh -c "(printf '${head}'; printf '${hold}'; while sleep 0.2; do printf x; done) | nc ${broker} > /tmp/tun-held; echo done > /tmp/tun-done" </dev/null >/dev/null 2>&1 &`,
  );

  await waitFor('the held tunnel to open', async () => {
    const opened = await tryInImp(name, 'grep -q " 200 " /tmp/tun-held');

    if (!opened) {
      throw new Error('no 200 yet');
    }
  });

  await runShellInImp(
    name,
    `setsid sh -c "(until [ -f /tmp/tun-go ]; do sleep 0.1; done; printf '${head}'; until grep -q ' 403 ' /tmp/tun-late; do sleep 0.1; done) | nc ${broker} > /tmp/tun-late" </dev/null >/dev/null 2>&1 &`,
  );

  // The broker's port, 7081, shows as 1BA9 in /proc/net/tcp.
  await waitFor('the late connection to open beside the held one', async () => {
    const count = await runShellInImp(
      name,
      `awk '$3 ~ /:1BA9$/ && $4 == "01"' /proc/net/tcp | wc -l`,
    );

    if (parseWholeNumber(count, 'the broker connections') < 2) {
      throw new Error(`${count.trim()} connections to the broker`);
    }
  });

  await runImp('policy', name, 'box', '--allow', 'example.com');
  await runShellInImp(name, 'touch /tmp/tun-go');

  const ended = await waitFor('the held tunnel to end', async () => {
    const done = await tryInImp(name, 'test -f /tmp/tun-done');

    if (!done) {
      throw new Error('the held tunnel is still open');
    }

    return done;
  });

  const refused = await waitFor('the late head to be refused', async () => {
    const found = await tryInImp(name, 'grep -q " 403 " /tmp/tun-late');

    if (!found) {
      throw new Error('no 403 yet');
    }

    return found;
  });

  expect(ended).toBeTrue();
  expect(refused).toBeTrue();
});

test('it lets a none imp reach nothing, and open gives it all back', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}none`;

  await runImp(
    'new',
    name,
    '--image',
    resolveImageName('e2e-tiny'),
    '--memory',
    '256',
    '--policy',
    'box',
    '--allow',
    'example.com',
  );

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);
  await runImp('policy', name, 'none');

  const shutFetch = await tryGetFromImp(name, 'http://example.com/');
  const shutDial = await tryDialFromImp(name, '9.9.9.9', 443);

  await runImp('policy', name, 'open');

  const reopened = await tryGetFromImp(name, 'http://example.org/');

  expect(shutFetch).toBeFalse();
  expect(shutDial).toBeFalse();
  expect(reopened).toBeTrue();
});

test('it refuses a none imp with a grant and a reverse forward every direct connection and every other broker host, and impd at each address', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}none-grant`;
  const secret = `${ctx.prefix}none-model`;

  const page = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    routes: { '/*': () => new Response('e2e-tool-ok\n') },
  });

  ctx.stack.defer(() => page.stop(true));

  await runImp(
    'new',
    name,
    '--image',
    resolveImageName('e2e-tiny'),
    '--memory',
    '256',
    '--policy',
    'none',
  );

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  await ctx.client.secrets.add({ name: secret, kind: 'anthropic', value: `e2e-${randomUUID()}` });

  registerRemoval(ctx.stack, config.keep, () => removeSecretIfPresent(ctx.client, secret));

  await runImp('grant', name, secret);

  const reverse = await startReverse(name, `0:${String(page.port)}`);

  ctx.stack.defer(async () => {
    await reverse.stop();
  });

  const [port = ''] = reverse.guests;

  const route = await runShellInImp(name, 'ip -4 route show default');

  const gateway = /via (?<ip>[\d.]+)/v.exec(route)?.groups?.['ip'] ?? '';

  const container = await runInContainer(['hostname', '-i']);

  const containerIp = container.stdout.trim().split(' ')[0] ?? '';

  const tailnetIp = await waitForTailnetIp();

  // The broker answers a CONNECT with its status line: 200 for a granted host, whose tunnel it
  // ends in its own TLS terminator, and 403 for any host the none policy leaves out. busybox nc
  // stops at the end of its stdin, so the sleep holds it open for the answer.
  const readConnectStatus = (host: string) =>
    runShellInImp(
      name,
      String.raw`(printf 'CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n'; sleep 3) | nc -w 5 ${gateway} 7081 | head -n 1 | cut -d ' ' -f 2`,
    );

  const forward = await runShellInImp(name, `wget -qO- http://127.0.0.1:${port}/`);
  const granted = await readConnectStatus('api.anthropic.com');
  const other = await readConnectStatus('example.com');

  const targets = [
    ['1.1.1.1', 443],
    ['169.254.169.254', 80],
    ['100.100.100.100', 80],
    [gateway, 7070],
    [containerIp, 7070],
    [tailnetIp, 7070],
  ] as const;

  const dials = await Promise.all(
    targets.map(async ([ip, dialPort]) => ({
      target: `${ip}:${String(dialPort)}`,
      isConnected: await tryDialFromImp(name, ip, dialPort),
    })),
  );

  expect(forward).toBe('e2e-tool-ok');
  expect(granted).toBe('200');
  expect(other).toBe('403');

  expect(dials).toStrictEqual(
    targets.map(([ip, dialPort]) => ({ target: `${ip}:${String(dialPort)}`, isConnected: false })),
  );
});
