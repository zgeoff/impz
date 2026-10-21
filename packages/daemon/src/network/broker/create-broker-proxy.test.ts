import { expect, mock, onTestFinished, test } from 'bun:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMockBrokerRule } from '@impz/api/test-utils/build-mock-broker-rule';
import { buildMockOAuthConfig } from '@impz/api/test-utils/build-mock-oauth-config';
import { buildStubAnswerQueue } from '@impz/test-utils/build-stub-answer-queue';
import { server } from '@impz/test-utils/mock-server';
import { waitFor } from '@impz/test-utils/wait-for';
import { HttpResponse, http } from 'msw';
import { buildMockNewImage } from '../../../testing/imps/build-mock-new-image';
import { buildStubBrokerGuest } from '../../../testing/network/build-stub-broker-guest';
import { createStubBrokerTokenEndpoint } from '../../../testing/network/create-stub-broker-token-endpoint';
import { startStubBrokerGuestSocket } from '../../../testing/network/start-stub-broker-guest-socket';
import { startStubBrokerHoldTarget } from '../../../testing/network/start-stub-broker-hold-target';
import { startStubBrokerPlainUpstream } from '../../../testing/network/start-stub-broker-plain-upstream';
import { startStubBrokerReplyTarget } from '../../../testing/network/start-stub-broker-reply-target';
import { startStubBrokerTlsUpstream } from '../../../testing/network/start-stub-broker-tls-upstream';
import { startStubBrokerTunnel } from '../../../testing/network/start-stub-broker-tunnel';
import { buildStubHeldAnswer } from '../../../testing/platform/build-stub-held-answer';
import { startTestImpd } from '../../../testing/start-test-impd';
import { listAuditEntries } from '../../platform/db/broker-audit';
import { createImage } from '../../platform/db/images';
import { readImpByName } from '../../platform/db/imps';
import { listGrantNames, readSecret, removeCheckedGrant } from '../../platform/db/secrets';
import { buildImagePaths } from '../../vm/storage/data-layout';
import { loadOrCreateBrokerCa } from './broker-ca';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'broker-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const tunnelled: { method: string; path: string; authorization: string | null }[] = [];

  const tunnelAnswers = new Map<string, () => Response>();

  const realHost = await startStubBrokerTlsUpstream(stack, {
    directory: join(dataDir, 'real-host'),
    host: 'api.github.com',
    respond: (request: Request) => {
      const path = new URL(request.url).pathname;

      tunnelled.push({
        method: request.method,
        path,
        authorization: request.headers.get('authorization'),
      });

      const answer = tunnelAnswers.get(path);

      return answer === undefined
        ? new Response(`the real host has no answer for ${path}`, { status: 500 })
        : answer();
    },
  });

  const seen: { method: string; path: string; authorization: string | null; bodyBytes: number }[] =
    [];

  const answers = new Map<string, () => Response | Promise<Response>>();

  const upstream = await startStubBrokerTlsUpstream(stack, {
    directory: join(dataDir, 'upstream'),
    respond: async (request: Request) => {
      const body = await request.arrayBuffer();

      const path = new URL(request.url).pathname;

      const answer = answers.get(path);

      const response =
        answer === undefined
          ? new Response(`the upstream has no answer for ${path}`, { status: 500 })
          : await answer();

      seen.push({
        method: request.method,
        path,
        authorization: request.headers.get('authorization'),
        bodyBytes: body.byteLength,
      });

      return response;
    },
  });

  const upstreamsFile = join(dataDir, 'upstreams.json');
  const ruleRead = { hook: (): Promise<void> => Promise.resolve() };

  const tunnelPorts = new Map([[443, realHost.port]]);

  const clock = { nowMs: Date.now() };
  const log = mock<(message: string) => void>(() => {});

  const harness = await startTestImpd(stack, {
    dataDir,
    env: { IMP_SUBNET: '127.0.0.0/16', IMP_BROKER_TEST_UPSTREAMS: upstreamsFile },
    onLog: log,
    brokerNow: () => clock.nowMs,
    resolveTunnelTarget: () => Promise.resolve('127.0.0.1'),
    dialTunnel: (address, port) =>
      createConnection({ host: address, port: tunnelPorts.get(port) ?? port }),
    afterRuleRead: () => ruleRead.hook(),
  });

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(dataDir, image.digest).rootfs, 'rootfs');

  await createImage(harness.db, image);

  const proxyPort = harness.config.brokerPort;
  const caFile = join(dataDir, 'broker', 'ca', 'ca.pem');

  return {
    stack,
    db: harness.db,
    dataDir,
    impd: harness.impd,
    clock,
    log,
    client: harness.client,
    seen,
    tunnelled,
    answers,
    tunnelAnswers,
    ruleRead,
    upstreamsFile,
    upstreamOrigin: upstream.origin,
    upstreamCaPem: upstream.caPem,
    proxyPort,
    caFile,

    guest: buildStubBrokerGuest({ proxyPort, caFile, address: '127.0.0.2' }),
  };
}

test('it sends the real credential in place of the placeholder to a granted host', async () => {
  const ctx = await setupTest();

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: ctx.upstreamCaPem, upstreams: { 'api.github.com': ctx.upstreamOrigin } }),
  );

  ctx.answers.set('/user', () => new Response('from upstream'));

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.impd.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.impd.broker.addGrant('dev', 'gh');

  const result = await ctx.guest.curl('https://api.github.com/user?x=1', [
    '-H',
    'Authorization: Bearer imp-broker-placeholder',
  ]);

  expect(result).toStrictEqual({ code: 0, stdout: 'from upstream', stderr: '' });

  expect(ctx.seen).toStrictEqual([
    { method: 'GET', path: '/user', authorization: 'Bearer ghp_real', bodyBytes: 0 },
  ]);
});

test('it records an audit row for a forwarded request', async () => {
  const ctx = await setupTest();

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: ctx.upstreamCaPem, upstreams: { 'api.github.com': ctx.upstreamOrigin } }),
  );

  ctx.answers.set('/user', () => new Response('from upstream'));

  const dev = await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.impd.broker.addGrant('dev', 'gh');
  await ctx.guest.curl('https://api.github.com/user?x=1');

  const audit: unknown = await waitFor(async () => {
    const rows = await listAuditEntries(ctx.db, dev.id, 10, null);

    expect(rows).toHaveLength(1);

    return rows;
  });

  expect(audit).toStrictEqual([
    {
      at: expect.toBeValidDate() as unknown,
      imp: 'dev',
      secret: 'gh',
      method: 'GET',
      host: 'api.github.com',
      path: '/user',
      status: 200,
      requestBytes: 0,
      responseBytes: 'from upstream'.length,
      durationMs: expect.toBeNumber() as unknown,
    },
  ]);
});

test('it records the audit row of a request that ends after its imp is destroyed', async () => {
  const ctx = await setupTest();

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: ctx.upstreamCaPem, upstreams: { 'api.github.com': ctx.upstreamOrigin } }),
  );

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.impd.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.impd.broker.addGrant('dev', 'gh');

  const held = buildStubHeldAnswer();

  ctx.answers.set('/slow', held.answer);

  const request = ctx.guest.curl('https://api.github.com/slow');

  await held.arrived;

  const destroy = ctx.client.imps.destroy({ name: 'dev' });

  await waitFor(async () => {
    const imp = await readImpByName(ctx.db, 'dev');

    expect(imp).toBeUndefined();
  });

  held.release(new Response('from upstream'));

  await request;
  await destroy;

  const audit: unknown = await waitFor(async () => {
    const rows = await listAuditEntries(ctx.db, null, 10, null);

    expect(rows).toHaveLength(1);

    return rows;
  });

  expect(audit).toStrictEqual([
    {
      at: expect.toBeValidDate() as unknown,
      imp: 'dev',
      secret: 'gh',
      method: 'GET',
      host: 'api.github.com',
      path: '/slow',
      status: 200,
      requestBytes: 0,
      responseBytes: 'from upstream'.length,
      durationMs: expect.toBeNumber() as unknown,
    },
  ]);

  expect(ctx.log.mock.calls).not.toContainEqual([expect.toInclude('audit write failed')]);
});

test('it streams a large upload through and counts its bytes', async () => {
  const ctx = await setupTest();

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: ctx.upstreamCaPem, upstreams: { 'api.github.com': ctx.upstreamOrigin } }),
  );

  ctx.answers.set('/upload', () => new Response('from upstream'));

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.impd.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.impd.broker.addGrant('dev', 'gh');

  const body = join(ctx.dataDir, 'pack');

  await writeFile(body, Buffer.alloc(3 * 1024 * 1024 + 17, 7));

  await ctx.guest.curl('https://api.github.com/upload', ['--data-binary', `@${body}`]);

  const audit = await waitFor(async () => {
    const rows = await listAuditEntries(ctx.db, null, 10, null);

    expect(rows).toHaveLength(1);

    return rows;
  });

  expect(ctx.seen.map((entry) => entry.bodyBytes)).toStrictEqual([3 * 1024 * 1024 + 17]);
  expect(audit.map((row) => row.requestBytes)).toStrictEqual([3 * 1024 * 1024 + 17]);
});

test('it tunnels an ungranted host, whose real certificate the guest does not trust', async () => {
  const ctx = await setupTest();

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: ctx.upstreamCaPem, upstreams: { 'api.github.com': ctx.upstreamOrigin } }),
  );

  await ctx.client.imps.create({ name: 'dev' });

  const result = await ctx.guest.curl('https://api.github.com/user');

  expect(result).toStrictEqual({ code: 60, stdout: '', stderr: expect.toStartWith('curl: (60) ') });
  expect(ctx.tunnelled).toStrictEqual([]);
  expect(ctx.seen).toStrictEqual([]);
});

test('it adds no credential to an ungranted host the guest reaches past the certificate', async () => {
  const ctx = await setupTest();

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: ctx.upstreamCaPem, upstreams: { 'api.github.com': ctx.upstreamOrigin } }),
  );

  ctx.tunnelAnswers.set('/user', () => new Response('from the real host'));

  await ctx.client.imps.create({ name: 'dev' });

  const result = await ctx.guest.curl('https://api.github.com/user', [
    '-k',
    '-H',
    'Authorization: Bearer imp-broker-placeholder',
  ]);

  expect(result).toStrictEqual({ code: 0, stdout: 'from the real host', stderr: '' });

  expect(ctx.tunnelled).toStrictEqual([
    { method: 'GET', path: '/user', authorization: 'Bearer imp-broker-placeholder' },
  ]);

  expect(ctx.seen).toStrictEqual([]);
});

test('it dials the checked address for a plain tunnel under an open policy', async () => {
  const ctx = await setupTest();
  const target = await startStubBrokerReplyTarget(ctx.stack, 'tunnel');

  await ctx.client.imps.create({ name: 'dev' });

  const result = await ctx.guest.curl(`http://plain.test:${String(target.port)}/`, [
    '--proxytunnel',
  ]);

  expect(result).toStrictEqual({ code: 0, stdout: 'tunnel', stderr: '' });
});

test('it relays the guest’s bytes to the tunnel target', async () => {
  const ctx = await setupTest();
  const target = await startStubBrokerReplyTarget(ctx.stack, 'tunnel');

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.guest.curl(`http://plain.test:${String(target.port)}/hello`, ['--proxytunnel']);

  // curl adds its own headers after the Host line
  expect(target.received).toStrictEqual([
    expect.toStartWith(`GET /hello HTTP/1.1\r\nHost: plain.test:${String(target.port)}\r\n`),
  ]);
});

test('it tunnels to a host a box policy lists', async () => {
  const ctx = await setupTest();
  const target = await startStubBrokerReplyTarget(ctx.stack, 'tunnel');

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.impd.egress.setPolicy('dev', { mode: 'box', allow: ['plain.test'] });

  const result = await ctx.guest.curl(`http://plain.test:${String(target.port)}/`, [
    '--proxytunnel',
  ]);

  expect(result).toStrictEqual({ code: 0, stdout: 'tunnel', stderr: '' });
});

test('it refuses a tunnel to a host a box policy does not list', async () => {
  const ctx = await setupTest();
  const target = await startStubBrokerReplyTarget(ctx.stack, 'tunnel');

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.impd.egress.setPolicy('dev', { mode: 'box', allow: ['other.test'] });

  const guest = await startStubBrokerGuestSocket(ctx.stack, {
    port: ctx.proxyPort,
    address: '127.0.0.2',
  });

  guest.write(
    `CONNECT plain.test:${String(target.port)} HTTP/1.1\r\nHost: plain.test:${String(target.port)}\r\n\r\n`,
  );

  const reply = await guest.reply;

  expect(reply).toBe(
    'HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\ncontent-length: 63\r\n' +
      "connection: close\r\n\r\negress to plain.test is not allowed by the imp's egress policy\n",
  );
});

test('it audits a tunnel the egress policy refuses, with the imp, the host and the reason', async () => {
  const ctx = await setupTest();
  const target = await startStubBrokerReplyTarget(ctx.stack, 'tunnel');

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.impd.egress.setPolicy('dev', { mode: 'box', allow: ['other.test'] });

  const guest = await startStubBrokerGuestSocket(ctx.stack, {
    port: ctx.proxyPort,
    address: '127.0.0.2',
  });

  guest.write(`CONNECT plain.test:${String(target.port)} HTTP/1.1\r\n\r\n`);

  await guest.reply;

  const audit: unknown = await waitFor(async () => {
    const entries = await ctx.client.audit.refused({ name: 'dev' });

    expect(entries).toHaveLength(1);

    return entries;
  });

  expect(audit).toStrictEqual([
    {
      at: expect.toBeValidDate() as unknown,
      imp: 'dev',
      method: 'CONNECT',
      host: 'plain.test',
      path: null,
      status: 403,
      durationMs: expect.toBeNumber() as unknown,
      reason: 'egress-policy',
    },
  ]);
});

test('it keeps no credential, header, query or body in the audit row of a refused request', async () => {
  const ctx = await setupTest();

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: ctx.upstreamCaPem, upstreams: { 'api.github.com': ctx.upstreamOrigin } }),
  );

  const dev = await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.impd.broker.addGrant('dev', 'gh');

  const result = await ctx.guest.curl('https://api.github.com/repos/x?token=query-secret', [
    '-X',
    'POST',
    '--data',
    'body-secret',
    '-H',
    'Host: evil.test',
    '-H',
    'Authorization: Bearer imp-broker-placeholder',
  ]);

  const rows: unknown = await waitFor(async () => {
    const written = await ctx.db.selectFrom('broker_audit').selectAll().execute();

    expect(written).toHaveLength(1);

    return written;
  });

  expect(result.stdout).toBe('this connection is for api.github.com\n');
  expect(ctx.seen).toStrictEqual([]);

  expect(rows).toStrictEqual([
    {
      id: expect.toBeNumber() as unknown,
      imp_id: dev.id,
      imp_name: 'dev',
      secret_name: null,
      at: expect.toBeNumber() as unknown,
      method: 'POST',
      host: 'api.github.com',
      path: '/repos/x',
      status: 421,
      request_bytes: 0,
      response_bytes: 0,
      duration_ms: expect.toBeNumber() as unknown,
      reason: 'wrong-host',
    },
  ]);

  expect(
    ['ghp_real', 'imp-broker-placeholder', 'query-secret', 'body-secret', 'evil.test'].filter(
      (secret) => JSON.stringify(rows).includes(secret),
    ),
  ).toStrictEqual([]);
});

test('it refuses every tunnel under a closed egress policy', async () => {
  const ctx = await setupTest();
  const target = await startStubBrokerReplyTarget(ctx.stack, 'tunnel');

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.impd.egress.setPolicy('dev', { mode: 'none', allow: [] });

  const guest = await startStubBrokerGuestSocket(ctx.stack, {
    port: ctx.proxyPort,
    address: '127.0.0.2',
  });

  guest.write(
    `CONNECT plain.test:${String(target.port)} HTTP/1.1\r\nHost: plain.test:${String(target.port)}\r\n\r\n`,
  );

  const reply = await guest.reply;

  expect(reply).toBe(
    'HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\ncontent-length: 63\r\n' +
      "connection: close\r\n\r\negress to plain.test is not allowed by the imp's egress policy\n",
  );
});

test('it ends the open tunnels a tighter policy denies, and keeps the rest', async () => {
  const ctx = await setupTest();
  const target = await startStubBrokerHoldTarget(ctx.stack);

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.impd.egress.setPolicy('dev', { mode: 'box', allow: ['keep.test', 'drop.test'] });

  const keep = await startStubBrokerTunnel(ctx.stack, {
    proxyPort: ctx.proxyPort,
    address: '127.0.0.2',
    target: `keep.test:${String(target.port)}`,
  });

  const drop = await startStubBrokerTunnel(ctx.stack, {
    proxyPort: ctx.proxyPort,
    address: '127.0.0.2',
    target: `drop.test:${String(target.port)}`,
  });

  keep.sendHead();
  drop.sendHead();

  await Promise.all([keep.established, drop.established]);
  await ctx.impd.egress.setPolicy('dev', { mode: 'box', allow: ['keep.test'] });

  await drop.closed;

  expect(keep.isOpen()).toBeTrue();
});

test('it gives no tunnel to a connection opened under an open policy once a tighter one is set', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const early = await startStubBrokerTunnel(ctx.stack, {
    proxyPort: ctx.proxyPort,
    address: '127.0.0.2',
    target: 'late.test:9',
  });

  await ctx.impd.egress.setPolicy('dev', { mode: 'none', allow: [] });

  early.sendHead();

  expect(early.established).rejects.toThrow('HTTP/1.1 403 Forbidden');
});

test('it closes the connection of a guest on another imp’s gateway without a reply', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.impd.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.impd.broker.addGrant('dev', 'gh');

  const other = await startStubBrokerGuestSocket(ctx.stack, {
    port: ctx.proxyPort,
    address: '127.0.0.6',
  });

  other.write('CONNECT api.github.com:443 HTTP/1.1\r\nHost: api.github.com:443\r\n\r\n');

  const reply = await other.reply;

  expect(reply).toBe('');
});

test('it refuses a proxy request that is not a CONNECT', async () => {
  const ctx = await setupTest();

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: ctx.upstreamCaPem, upstreams: { 'api.github.com': ctx.upstreamOrigin } }),
  );

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.impd.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.impd.broker.addGrant('dev', 'gh');

  const result = await ctx.guest.curl('http://api.github.com/user');

  expect(result).toStrictEqual({ code: 0, stdout: 'only CONNECT is served\n', stderr: '' });
  expect(ctx.seen).toStrictEqual([]);
});

test('it stops sending the credential as soon as the grant is revoked', async () => {
  const ctx = await setupTest();

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: ctx.upstreamCaPem, upstreams: { 'api.github.com': ctx.upstreamOrigin } }),
  );

  ctx.answers.set('/a', () => new Response('from upstream'));

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.impd.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.impd.broker.addGrant('dev', 'gh');
  await ctx.guest.curl('https://api.github.com/a');
  await ctx.impd.broker.removeGrant('dev', 'gh');

  const result = await ctx.guest.curl('https://api.github.com/b');

  expect(result.code).toBe(60);
  expect(ctx.tunnelled).toStrictEqual([]);
  expect(ctx.seen.map((entry) => entry.path)).toStrictEqual(['/a']);
});

test('it passes a 204 through without a body', async () => {
  const ctx = await setupTest();

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: ctx.upstreamCaPem, upstreams: { 'api.github.com': ctx.upstreamOrigin } }),
  );

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.impd.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.impd.broker.addGrant('dev', 'gh');

  ctx.answers.set('/none', () => new Response(null, { status: 204 }));

  const result = await ctx.guest.curl('https://api.github.com/none', [
    '-w',
    '%{http_code} %{size_download}',
  ]);

  expect(result).toStrictEqual({ code: 0, stdout: '204 0', stderr: '' });
});

test('it passes a 304 through without a body', async () => {
  const ctx = await setupTest();

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: ctx.upstreamCaPem, upstreams: { 'api.github.com': ctx.upstreamOrigin } }),
  );

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.impd.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.impd.broker.addGrant('dev', 'gh');

  ctx.answers.set('/same', () => new Response(null, { status: 304 }));

  const result = await ctx.guest.curl('https://api.github.com/same', [
    '-w',
    '%{http_code} %{size_download}',
  ]);

  expect(result).toStrictEqual({ code: 0, stdout: '304 0', stderr: '' });
});

test('it passes a redirect through without following it', async () => {
  const ctx = await setupTest();

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: ctx.upstreamCaPem, upstreams: { 'api.github.com': ctx.upstreamOrigin } }),
  );

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.impd.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.impd.broker.addGrant('dev', 'gh');

  ctx.answers.set(
    '/moved',
    () =>
      new Response(null, { status: 302, headers: { location: 'https://objects.example.com/x' } }),
  );

  const result = await ctx.guest.curl('https://api.github.com/moved', [
    '-w',
    '%{http_code} %{redirect_url}',
  ]);

  expect(result).toStrictEqual({
    code: 0,
    stdout: '302 https://objects.example.com/x',
    stderr: '',
  });

  expect(ctx.seen.map((entry) => entry.path)).toStrictEqual(['/moved']);
});

test('it gives no credential to the next request on a connection whose grant is gone', async () => {
  const ctx = await setupTest();

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: ctx.upstreamCaPem, upstreams: { 'api.github.com': ctx.upstreamOrigin } }),
  );

  const dev = await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.impd.broker.addGrant('dev', 'gh');

  ctx.answers.set('/a', async () => {
    await removeCheckedGrant(ctx.db, dev.id, 'gh', null);

    return new Response('from upstream');
  });

  const result = await ctx.guest.curl('https://api.github.com/b', [
    '-w',
    ' %{http_code} %{num_connects}\n',
    'https://api.github.com/a',
  ]);

  expect(result).toStrictEqual({
    code: 0,
    stdout: 'from upstream 200 1\nno credential is granted for api.github.com\n 403 0\n',
    stderr: '',
  });

  expect(ctx.seen.map((entry) => entry.path)).toStrictEqual(['/a']);
});

test('it lets the request under way finish on a revoke, and the next gets no credential', async () => {
  const ctx = await setupTest();

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: ctx.upstreamCaPem, upstreams: { 'api.github.com': ctx.upstreamOrigin } }),
  );

  const dev = await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.impd.broker.addGrant('dev', 'gh');

  const revoke = { done: Promise.resolve() };

  ctx.answers.set('/a', async () => {
    revoke.done = ctx.impd.broker.removeGrant('dev', 'gh');

    await waitFor(async () => {
      const names = await listGrantNames(ctx.db, dev.id);

      expect(names).toStrictEqual([]);
    });

    return new Response('from upstream');
  });

  const result = await ctx.guest.curl('https://api.github.com/b', [
    '-w',
    ' %{http_code} %{num_connects}\n',
    'https://api.github.com/a',
  ]);

  await revoke.done;

  // curl exits 60 when it cannot verify the peer's certificate
  expect(result).toStrictEqual({
    code: 60,
    stdout: 'from upstream 200 1\n 000 1\n',
    stderr: expect.toStartWith('curl: (60) '),
  });

  expect(ctx.seen.map((entry) => entry.path)).toStrictEqual(['/a']);
  expect(ctx.tunnelled).toStrictEqual([]);
});

test('it never sends a rebound value to the host the secret had before', async () => {
  const ctx = await setupTest();

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: ctx.upstreamCaPem, upstreams: { 'api.github.com': ctx.upstreamOrigin } }),
  );

  await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({
    name: 'api',
    kind: 'custom',
    value: 'old-value',
    rules: [buildMockBrokerRule({ host: 'api.github.com' })],
  });

  await ctx.impd.broker.addGrant('dev', 'api');

  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();

  ctx.ruleRead.hook = async () => {
    reached.resolve();

    await release.promise;
  };

  const request = ctx.guest.curl('https://api.github.com/x');

  await reached.promise;

  const replaced = ctx.impd.broker.addSecret({
    name: 'api',
    kind: 'custom',
    value: 'new-value',
    rules: [buildMockBrokerRule({ host: 'other.example.com' })],
    replace: true,
    rebind: true,
  });

  await waitFor(async () => {
    const secret = await readSecret(ctx.db, 'api');
    const files = await readdir(join(ctx.dataDir, 'secrets'));

    expect(secret?.rules[0]?.host).toBe('other.example.com');
    expect(files).toHaveLength(1);
  });

  release.resolve();

  const [result] = await Promise.all([request, replaced]);

  expect(result).toStrictEqual({
    code: 0,
    stdout: 'no credential is granted for api.github.com\n',
    stderr: '',
  });

  expect(ctx.seen).toStrictEqual([]);
});

test('it sends the rotated value on the next request, with the grant kept', async () => {
  const ctx = await setupTest();

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: ctx.upstreamCaPem, upstreams: { 'api.github.com': ctx.upstreamOrigin } }),
  );

  ctx.answers.set('/one', () => new Response('from upstream'));
  ctx.answers.set('/two', () => new Response('from upstream'));

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.impd.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.impd.broker.addGrant('dev', 'gh');
  await ctx.guest.curl('https://api.github.com/one');

  await ctx.impd.broker.addSecret({
    name: 'gh',
    kind: 'github',
    value: 'ghp_rotated',
    replace: true,
  });

  const result = await ctx.guest.curl('https://api.github.com/two');

  expect(result.code).toBe(0);

  expect(ctx.seen.map((entry) => `${entry.path} ${String(entry.authorization)}`)).toStrictEqual([
    '/one Bearer ghp_real',
    '/two Bearer ghp_rotated',
  ]);
});

test('it sends the request of a host with no public name to its rule’s upstream', async () => {
  const ctx = await setupTest();

  const received: { authorization: string | null; url: string }[] = [];

  server.use(
    http.get('http://svc-upstream.test:18081/v1/ping', (info) => {
      received.push({
        authorization: info.request.headers.get('authorization'),
        url: info.request.url,
      });

      return HttpResponse.text('from the rule upstream');
    }),
  );

  await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({
    name: 'op',
    kind: 'custom',
    value: 'real-token',
    rules: [
      buildMockBrokerRule({ host: 'svc.imp.internal', upstream: 'http://svc-upstream.test:18081' }),
    ],
  });

  await ctx.impd.broker.addGrant('dev', 'op');

  const result = await ctx.guest.curl('https://svc.imp.internal/v1/ping', [
    '-H',
    'Authorization: Bearer imp-broker-placeholder',
  ]);

  expect(result).toStrictEqual({ code: 0, stdout: 'from the rule upstream', stderr: '' });

  expect(received).toStrictEqual([
    { authorization: 'Bearer real-token', url: 'http://svc-upstream.test:18081/v1/ping' },
  ]);

  expect(ctx.seen).toStrictEqual([]);
});

test('it gives a rule’s upstream its own authority as the Host', async () => {
  const ctx = await setupTest();

  const hosts: (string | null)[] = [];

  const upstream = startStubBrokerPlainUpstream(ctx.stack, (request) => {
    hosts.push(request.headers.get('host'));

    return new Response('from the rule upstream');
  });

  await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({
    name: 'op',
    kind: 'custom',
    value: 'real-token',
    rules: [buildMockBrokerRule({ host: 'svc.imp.internal', upstream: upstream.origin })],
  });

  await ctx.impd.broker.addGrant('dev', 'op');
  await ctx.guest.curl('https://svc.imp.internal/v1/ping');

  expect(hosts).toStrictEqual([`127.0.0.1:${String(upstream.port)}`]);
});

test('it audits a request sent to a rule’s upstream under the guest’s host', async () => {
  const ctx = await setupTest();

  server.use(
    http.get('http://svc-upstream.test:18081/v1/ping', () =>
      HttpResponse.text('from the rule upstream'),
    ),
  );

  const dev = await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({
    name: 'op',
    kind: 'custom',
    value: 'real-token',
    rules: [
      buildMockBrokerRule({ host: 'svc.imp.internal', upstream: 'http://svc-upstream.test:18081' }),
    ],
  });

  await ctx.impd.broker.addGrant('dev', 'op');
  await ctx.guest.curl('https://svc.imp.internal/v1/ping');

  const audit = await waitFor(async () => {
    const rows = await listAuditEntries(ctx.db, dev.id, 10, null);

    expect(rows).toHaveLength(1);

    return rows;
  });

  expect(audit.map((row) => [row.secret, row.host, row.path])).toStrictEqual([
    ['op', 'svc.imp.internal', '/v1/ping'],
  ]);
});

test('it sends the next request to the host’s own origin once a rebind drops the upstream', async () => {
  const ctx = await setupTest();

  const received: string[] = [];

  server.use(
    http.get('http://svc-upstream.test:18081/v1/ping', () =>
      HttpResponse.text('from the rule upstream'),
    ),
    http.get('https://svc.imp.internal/v1/ping', (info) => {
      received.push(info.request.headers.get('authorization') ?? '');

      return HttpResponse.text('from the host itself');
    }),
  );

  await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({
    name: 'op',
    kind: 'custom',
    value: 'real-token',
    rules: [
      buildMockBrokerRule({ host: 'svc.imp.internal', upstream: 'http://svc-upstream.test:18081' }),
    ],
  });

  await ctx.impd.broker.addGrant('dev', 'op');
  await ctx.guest.curl('https://svc.imp.internal/v1/ping');

  await ctx.impd.broker.addSecret({
    name: 'op',
    kind: 'custom',
    value: 'real-token',
    rules: [buildMockBrokerRule({ host: 'svc.imp.internal' })],
    replace: true,
    rebind: true,
  });

  await ctx.impd.broker.addGrant('dev', 'op');

  const result = await ctx.guest.curl('https://svc.imp.internal/v1/ping');

  expect(result).toStrictEqual({ code: 0, stdout: 'from the host itself', stderr: '' });
  expect(received).toStrictEqual(['Bearer real-token']);
});

test('it refuses a test upstream whose certificate the file’s CA did not sign', async () => {
  const ctx = await setupTest();
  const otherCa = await loadOrCreateBrokerCa(join(ctx.dataDir, 'other-ca'));

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: otherCa.certPem, upstreams: { 'api.github.com': ctx.upstreamOrigin } }),
  );

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.impd.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.impd.broker.addGrant('dev', 'gh');

  const result = await ctx.guest.curl('https://api.github.com/user');

  expect(result).toStrictEqual({ code: 0, stdout: 'could not reach api.github.com\n', stderr: '' });
  expect(ctx.seen).toStrictEqual([]);
});

test('it sends the real credential with a request inside the grant’s filter', async () => {
  const ctx = await setupTest();

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: ctx.upstreamCaPem, upstreams: { 'api.github.com': ctx.upstreamOrigin } }),
  );

  ctx.answers.set('/repos/a/b/issues', () => new Response('the issues'));

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.impd.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });

  await ctx.client.grants.add({
    name: 'dev',
    secret: 'gh',
    filter: { methods: ['GET'], paths: ['/repos/*/*/issues'] },
  });

  const result = await ctx.guest.curl('https://api.github.com/repos/a/b/issues?state=open', [
    '-H',
    'Authorization: Bearer imp-broker-placeholder',
  ]);

  expect(result).toStrictEqual({ code: 0, stdout: 'the issues', stderr: '' });

  expect(ctx.seen).toStrictEqual([
    { method: 'GET', path: '/repos/a/b/issues', authorization: 'Bearer ghp_real', bodyBytes: 0 },
  ]);
});

test('it refuses a method outside the grant’s filter and audits it with the reason', async () => {
  const ctx = await setupTest();

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: ctx.upstreamCaPem, upstreams: { 'api.github.com': ctx.upstreamOrigin } }),
  );

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.impd.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });

  await ctx.client.grants.add({
    name: 'dev',
    secret: 'gh',
    filter: { methods: ['GET'], paths: ['/repos/*/*/issues'] },
  });

  const result = await ctx.guest.curl('https://api.github.com/repos/a/b/issues', [
    '-X',
    'POST',
    '--data',
    'body-secret',
    '-H',
    'Authorization: Bearer imp-broker-placeholder',
  ]);

  const audit: unknown = await waitFor(async () => {
    const entries = await ctx.client.audit.refused({ name: 'dev' });

    expect(entries).toHaveLength(1);

    return entries;
  });

  expect(result).toStrictEqual({
    code: 0,
    stdout: 'the grant for api.github.com does not cover POST /repos/a/b/issues\n',
    stderr: '',
  });

  expect(ctx.seen).toStrictEqual([]);

  expect(audit).toStrictEqual([
    {
      at: expect.toBeValidDate() as unknown,
      imp: 'dev',
      method: 'POST',
      host: 'api.github.com',
      path: '/repos/a/b/issues',
      status: 403,
      durationMs: expect.toBeNumber() as unknown,
      reason: 'outside-filter',
    },
  ]);
});

test('it refuses a path outside the grant’s filter and audits it with the reason', async () => {
  const ctx = await setupTest();

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: ctx.upstreamCaPem, upstreams: { 'api.github.com': ctx.upstreamOrigin } }),
  );

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.impd.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });

  await ctx.client.grants.add({
    name: 'dev',
    secret: 'gh',
    filter: { methods: ['GET'], paths: ['/repos/*/*/issues'] },
  });

  const result = await ctx.guest.curl('https://api.github.com/repos/a/b/collaborators?x=1', [
    '-H',
    'Authorization: Bearer imp-broker-placeholder',
  ]);

  const audit: unknown = await waitFor(async () => {
    const entries = await ctx.client.audit.refused({ name: 'dev' });

    expect(entries).toHaveLength(1);

    return entries;
  });

  expect(result).toStrictEqual({
    code: 0,
    stdout: 'the grant for api.github.com does not cover GET /repos/a/b/collaborators\n',
    stderr: '',
  });

  expect(ctx.seen).toStrictEqual([]);

  expect(audit).toStrictEqual([
    {
      at: expect.toBeValidDate() as unknown,
      imp: 'dev',
      method: 'GET',
      host: 'api.github.com',
      path: '/repos/a/b/collaborators',
      status: 403,
      durationMs: expect.toBeNumber() as unknown,
      reason: 'outside-filter',
    },
  ]);
});

test('it applies a filter given to an existing grant from the next request on', async () => {
  const ctx = await setupTest();

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: ctx.upstreamCaPem, upstreams: { 'api.github.com': ctx.upstreamOrigin } }),
  );

  ctx.answers.set('/user', () => new Response('from upstream'));

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.impd.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });
  await ctx.guest.curl('https://api.github.com/user');
  await ctx.client.grants.add({ name: 'dev', secret: 'gh', filter: { paths: ['/repos/**'] } });

  const result = await ctx.guest.curl('https://api.github.com/user');

  expect(result.stdout).toBe('the grant for api.github.com does not cover GET /user\n');

  expect(ctx.seen).toStrictEqual([
    { method: 'GET', path: '/user', authorization: 'Bearer ghp_real', bodyBytes: 0 },
  ]);
});

test('it sends the current access token to the granted host', async () => {
  const ctx = await setupTest();

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: ctx.upstreamCaPem, upstreams: { 'api.example.com': ctx.upstreamOrigin } }),
  );

  ctx.answers.set('/v1', () => new Response('from the api'));

  const endpoint = createStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(endpoint.handler);

  endpoint.issue('fake-refresh-0', {
    access_token: 'fake-access-1',
    refresh_token: 'fake-refresh-1',
    expires_in: 3600,
  });

  await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule({ host: 'api.example.com' })],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
  });

  await ctx.impd.broker.addGrant('dev', 'codex');

  const result = await ctx.guest.curl('https://api.example.com/v1', [
    '-H',
    'Authorization: Bearer imp-broker-placeholder',
  ]);

  expect(result).toStrictEqual({ code: 0, stdout: 'from the api', stderr: '' });

  expect(ctx.seen).toStrictEqual([
    { method: 'GET', path: '/v1', authorization: 'Bearer fake-access-1', bodyBytes: 0 },
  ]);
});

test('it sends the new access token after a refresh that used the rotated refresh token', async () => {
  const ctx = await setupTest();

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: ctx.upstreamCaPem, upstreams: { 'api.example.com': ctx.upstreamOrigin } }),
  );

  ctx.answers.set('/v2', () => new Response('from the api'));

  const endpoint = createStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(endpoint.handler);

  endpoint.issue('fake-refresh-0', {
    access_token: 'fake-access-1',
    refresh_token: 'fake-refresh-1',
    expires_in: 3600,
  });

  endpoint.issue('fake-refresh-1', {
    access_token: 'fake-access-2',
    refresh_token: 'fake-refresh-2',
    expires_in: 3600,
  });

  await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule({ host: 'api.example.com' })],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
  });

  await ctx.impd.broker.addGrant('dev', 'codex');
  await ctx.impd.broker.refreshSecret('codex');
  await ctx.guest.curl('https://api.example.com/v2');

  expect(ctx.seen).toStrictEqual([
    { method: 'GET', path: '/v2', authorization: 'Bearer fake-access-2', bodyBytes: 0 },
  ]);

  expect(endpoint.requests.map((request) => request.refreshToken)).toStrictEqual([
    'fake-refresh-0',
    'fake-refresh-1',
  ]);
});

test('it refreshes an access token the granted host revoked and sends the request again with the new one', async () => {
  const ctx = await setupTest();

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: ctx.upstreamCaPem, upstreams: { 'api.example.com': ctx.upstreamOrigin } }),
  );

  const statuses = buildStubAnswerQueue([401, 200]);

  ctx.answers.set('/v1', () => new Response('from the api', { status: statuses.next() }));

  const endpoint = createStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(endpoint.handler);

  endpoint.issue('fake-refresh-0', {
    access_token: 'fake-access-1',
    refresh_token: 'fake-refresh-1',
    expires_in: 240 * 3600,
  });

  endpoint.issue('fake-refresh-1', {
    access_token: 'fake-access-2',
    refresh_token: 'fake-refresh-2',
    expires_in: 240 * 3600,
  });

  await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule({ host: 'api.example.com' })],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
  });

  await ctx.impd.broker.addGrant('dev', 'codex');

  ctx.clock.nowMs += 24 * 3_600_000;

  const result = await ctx.guest.curl('https://api.example.com/v1');

  expect(result).toStrictEqual({ code: 0, stdout: 'from the api', stderr: '' });

  expect(ctx.seen).toStrictEqual([
    { method: 'GET', path: '/v1', authorization: 'Bearer fake-access-1', bodyBytes: 0 },
    { method: 'GET', path: '/v1', authorization: 'Bearer fake-access-2', bodyBytes: 0 },
  ]);
});

test('it gives no credential for a secret with no access token', async () => {
  const ctx = await setupTest();

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: ctx.upstreamCaPem, upstreams: { 'api.example.com': ctx.upstreamOrigin } }),
  );

  server.use(createStubBrokerTokenEndpoint('https://auth.example.com/oauth/token').handler);

  await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule({ host: 'api.example.com' })],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
  });

  await ctx.impd.broker.addGrant('dev', 'codex');

  const result = await ctx.guest.curl('https://api.example.com/v1', ['-w', '%{http_code}']);

  expect(result).toStrictEqual({
    code: 0,
    stdout: 'no credential is granted for api.example.com\n403',
    stderr: '',
  });

  expect(ctx.seen).toStrictEqual([]);
});

test('it keeps sending the valid access token of a secret that needs a new sign-in', async () => {
  const ctx = await setupTest();

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: ctx.upstreamCaPem, upstreams: { 'api.example.com': ctx.upstreamOrigin } }),
  );

  ctx.answers.set('/v2', () => new Response('from the api'));

  const endpoint = createStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(endpoint.handler);

  endpoint.issue('fake-refresh-0', {
    access_token: 'fake-access-1',
    refresh_token: 'fake-refresh-1',
    expires_in: 3600,
  });

  await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule({ host: 'api.example.com' })],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
  });

  await ctx.impd.broker.addGrant('dev', 'codex');

  const refreshed = await ctx.impd.broker.refreshSecret('codex');

  await ctx.guest.curl('https://api.example.com/v2');

  expect(refreshed.oauth?.status).toBe('needs_login');

  expect(ctx.seen).toStrictEqual([
    { method: 'GET', path: '/v2', authorization: 'Bearer fake-access-1', bodyBytes: 0 },
  ]);
});

test('it answers a websocket upgrade 426 and never reaches the upstream', async () => {
  const ctx = await setupTest();

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: ctx.upstreamCaPem, upstreams: { 'api.example.com': ctx.upstreamOrigin } }),
  );

  const endpoint = createStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(endpoint.handler);
  endpoint.issue('fake-refresh-0', { access_token: 'fake-access-1', expires_in: 3600 });

  await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule({ host: 'api.example.com' })],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
  });

  await ctx.impd.broker.addGrant('dev', 'codex');

  const result = await ctx.guest.curl('https://api.example.com/socket', [
    '-H',
    'Connection: Upgrade',
    '-H',
    'Upgrade: websocket',
    '-w',
    '%{http_code}',
  ]);

  expect(result).toStrictEqual({
    code: 0,
    stdout: 'websocket upgrades are not supported through the broker\n426',
    stderr: '',
  });

  expect(ctx.seen).toStrictEqual([]);
});

test('it refreshes through a token host that the test-upstreams file routes', async () => {
  const ctx = await setupTest();

  const refreshTokens: string[] = [];

  const tokenHost = await startStubBrokerTlsUpstream(ctx.stack, {
    directory: join(ctx.dataDir, 'token-host'),
    respond: async (request: Request) => {
      const text = await request.text();

      const form = new URLSearchParams(text);

      refreshTokens.push(form.get('refresh_token') ?? '');

      return Response.json({
        access_token: 'fake-access-1',
        refresh_token: 'fake-refresh-1',
        expires_in: 3600,
      });
    },
  });

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: tokenHost.caPem, upstreams: { 'auth.example.com': tokenHost.origin } }),
  );

  await ctx.impd.broker.addSecret({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule({ host: 'api.example.com' })],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
  });

  const refreshed = await ctx.impd.broker.refreshSecret('codex');

  expect(refreshed.oauth?.status).toBe('ready');
  expect(refreshTokens).toStrictEqual(['fake-refresh-0', 'fake-refresh-1']);
});
