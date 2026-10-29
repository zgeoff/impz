import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMockBrokerRule } from '@impz/api/test-utils/build-mock-broker-rule';
import { buildMockOAuthConfig } from '@impz/api/test-utils/build-mock-oauth-config';
import { buildStubAnswerQueue } from '@impz/test-utils/build-stub-answer-queue';
import { server } from '@impz/test-utils/mock-server';
import { waitFor } from '@impz/test-utils/wait-for';
import { HttpResponse, http } from 'msw';
import invariant from 'tiny-invariant';
import { buildStubBrokerGuest } from '../../../../testing/network/build-stub-broker-guest';
import { createStubBrokerTokenEndpoint } from '../../../../testing/network/create-stub-broker-token-endpoint';
import { startStubBrokerGuestBridge } from '../../../../testing/network/start-stub-broker-guest-bridge';
import { startStubBrokerGuestSocket } from '../../../../testing/network/start-stub-broker-guest-socket';
import { startStubBrokerHoldTarget } from '../../../../testing/network/start-stub-broker-hold-target';
import { startStubBrokerPlainUpstream } from '../../../../testing/network/start-stub-broker-plain-upstream';
import { startStubBrokerReplyTarget } from '../../../../testing/network/start-stub-broker-reply-target';
import { startStubBrokerSocketUpstream } from '../../../../testing/network/start-stub-broker-socket-upstream';
import { startStubBrokerTlsUpstream } from '../../../../testing/network/start-stub-broker-tls-upstream';
import { startStubBrokerTunnel } from '../../../../testing/network/start-stub-broker-tunnel';
import { startStubPausedSocketGuest } from '../../../../testing/network/start-stub-paused-socket-guest';
import { buildQueryGate } from '../../../../testing/platform/build-query-gate';
import { buildStubHeldAnswer } from '../../../../testing/platform/build-stub-held-answer';
import { startTestImpd } from '../../../../testing/start-test-impd';
import { listAuditEntries } from '../../../platform/db/broker-audit';
import { readImpByName } from '../../../platform/db/imps';
import { listGrantNames, readSecret, removeCheckedGrant } from '../../../platform/db/secrets';
import { loadOrCreateBrokerCa } from '../tls/broker-ca';

async function setupTest() {
  // first, so a held read lets go before impd stops
  const frontGate = buildQueryGate('value_file');
  const terminatorGate = buildQueryGate('value_file');

  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'broker-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const tunnelled: {
    method: string;
    path: string;
    authorization: string | null;
    upgrade: string | null;
  }[] = [];

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
        upgrade: request.headers.get('upgrade'),
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

  const credentials: { authorization: string | null; apiKey: string | null }[] = [];

  const upstream = await startStubBrokerTlsUpstream(stack, {
    directory: join(dataDir, 'upstream'),
    respond: async (request: Request) => {
      const body = await request.arrayBuffer();

      const path = new URL(request.url).pathname;

      credentials.push({
        authorization: request.headers.get('authorization'),
        apiKey: request.headers.get('x-api-key'),
      });

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

  const tunnelPorts = new Map([[443, realHost.port]]);

  const clock = { nowMs: Date.UTC(2026, 0, 1) };

  const harness = await startTestImpd(stack, {
    dataDir,
    env: { IMP_SUBNET: '127.0.0.0/16', IMP_BROKER_TEST_UPSTREAMS: upstreamsFile },
    brokerNow: () => clock.nowMs,
    resolveTunnelTarget: () => Promise.resolve('127.0.0.1'),
    dialTunnel: (address, port) =>
      createConnection({ host: address, port: tunnelPorts.get(port) ?? port }),
    wrapDatabase: (db) => terminatorGate.wrap(frontGate.wrap(db)),
  });

  const proxyPort = harness.config.brokerPort;
  const caFile = join(dataDir, 'broker', 'ca', 'ca.pem');

  return {
    stack,
    db: harness.db,
    dataDir,
    impd: harness.impd,
    clock,
    client: harness.client,
    logs: harness.logs,
    seen,
    credentials,
    tunnelled,
    answers,
    tunnelAnswers,
    frontGate,
    terminatorGate,
    upstreamsFile,
    upstreamOrigin: upstream.origin,
    upstreamCaPem: upstream.caPem,
    proxyPort,
    caFile,
    createTestImage: harness.createTestImage,

    guest: buildStubBrokerGuest({ proxyPort, caFile, address: '127.0.0.2' }),
  };
}

test('it sends the real credential in place of the placeholder to a granted host', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

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

test.each([
  [{ preset: 'github' }, 'api.github.com', { authorization: 'Bearer ghp_real', apiKey: null }],
  [
    { preset: 'github' },
    'github.com',
    { authorization: 'Basic eC1hY2Nlc3MtdG9rZW46Z2hwX3JlYWw=', apiKey: null },
  ],
  [{ preset: 'github' }, 'uploads.github.com', { authorization: 'Bearer ghp_real', apiKey: null }],
  [{ preset: 'anthropic' }, 'api.anthropic.com', { authorization: null, apiKey: 'ghp_real' }],
  [{ preset: 'npm' }, 'registry.npmjs.org', { authorization: 'Bearer ghp_real', apiKey: null }],
  [{ kind: 'github' }, 'api.github.com', { authorization: 'Bearer ghp_real', apiKey: null }],
  [
    { kind: 'github' },
    'github.com',
    { authorization: 'Basic eC1hY2Nlc3MtdG9rZW46Z2hwX3JlYWw=', apiKey: null },
  ],
  [{ kind: 'anthropic' }, 'api.anthropic.com', { authorization: null, apiKey: 'ghp_real' }],
  [{ kind: 'npm' }, 'registry.npmjs.org', { authorization: 'Bearer ghp_real', apiKey: null }],
] as const)(
  'it sends the credential of %o to %s as the preset says',
  async (binding, host, sent) => {
    const ctx = await setupTest();

    await ctx.createTestImage('base');

    await writeFile(
      ctx.upstreamsFile,
      JSON.stringify({ ca: ctx.upstreamCaPem, upstreams: { [host]: ctx.upstreamOrigin } }),
    );

    ctx.answers.set('/thing', () => new Response('from upstream'));

    await ctx.client.imps.create({ name: 'dev' });
    await ctx.impd.broker.addSecret({ name: 'cred', value: 'ghp_real', ...binding });
    await ctx.impd.broker.addGrant('dev', 'cred');

    const result = await ctx.guest.curl(`https://${host}/thing`);

    expect(result).toStrictEqual({ code: 0, stdout: 'from upstream', stderr: '' });
    expect(ctx.credentials).toStrictEqual([sent]);
  },
);

test('it records an audit row for a forwarded request', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

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

  await ctx.createTestImage('base');

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

  expect(ctx.logs).not.toContainEqual(expect.toInclude('audit write failed'));
});

test('it streams a large upload through and counts its bytes', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

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

  await ctx.createTestImage('base');

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

  await ctx.createTestImage('base');

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
    {
      method: 'GET',
      path: '/user',
      authorization: 'Bearer imp-broker-placeholder',
      upgrade: null,
    },
  ]);

  expect(ctx.seen).toStrictEqual([]);
});

test('it tunnels a websocket upgrade to an ungranted host as sent, with no credential', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.tunnelAnswers.set('/socket', () => new Response('from the real host'));

  await ctx.client.imps.create({ name: 'dev' });

  const result = await ctx.guest.curl('https://api.github.com/socket', [
    '-k',
    '-H',
    'Authorization: Bearer imp-broker-placeholder',
    '-H',
    'Connection: Upgrade',
    '-H',
    'Upgrade: websocket',
  ]);

  expect(result).toStrictEqual({ code: 0, stdout: 'from the real host', stderr: '' });

  expect(ctx.tunnelled).toStrictEqual([
    {
      method: 'GET',
      path: '/socket',
      authorization: 'Bearer imp-broker-placeholder',
      upgrade: 'websocket',
    },
  ]);

  expect(ctx.seen).toStrictEqual([]);
});

test('it dials the checked address for a plain tunnel under an open policy', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const target = await startStubBrokerReplyTarget(ctx.stack, 'tunnel');

  await ctx.client.imps.create({ name: 'dev' });

  const result = await ctx.guest.curl(`http://plain.test:${String(target.port)}/`, [
    '--proxytunnel',
  ]);

  expect(result).toStrictEqual({ code: 0, stdout: 'tunnel', stderr: '' });
});

test('it relays the guest’s bytes to the tunnel target', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

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

  await ctx.createTestImage('base');

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

  await ctx.createTestImage('base');

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

  await ctx.createTestImage('base');

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

  await ctx.createTestImage('base');

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

  await ctx.createTestImage('base');

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

  await ctx.createTestImage('base');

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

  await ctx.createTestImage('base');
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

  await ctx.createTestImage('base');
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

  await ctx.createTestImage('base');

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

  await ctx.createTestImage('base');

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

  await ctx.createTestImage('base');

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

  await ctx.createTestImage('base');

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

  await ctx.createTestImage('base');

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

  await ctx.createTestImage('base');

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

  await ctx.createTestImage('base');

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

  await ctx.createTestImage('base');

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

  ctx.frontGate.arm();

  const request = ctx.guest.curl('https://api.github.com/x');

  await ctx.frontGate.reached;

  ctx.terminatorGate.arm();
  ctx.frontGate.release();

  await ctx.terminatorGate.reached;

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

  ctx.terminatorGate.release();

  const [result] = await Promise.all([request, replaced]);

  expect(result).toStrictEqual({
    code: 0,
    stdout: 'no credential is granted for api.github.com\n',
    stderr: '',
  });

  expect(ctx.seen).toStrictEqual([]);
});

test('it sends no credential for a grant whose value file is gone', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

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

  const secret = await readSecret(ctx.db, 'api');

  invariant(secret);

  await rm(join(ctx.dataDir, 'secrets', secret.valueFile));

  const result = await ctx.guest.curl('https://api.github.com/x');

  expect(result).toStrictEqual({
    code: 0,
    stdout: 'no credential is granted for api.github.com\n',
    stderr: '',
  });

  expect(ctx.seen).toStrictEqual([]);
});

test('it sends the rotated value on the next request, with the grant kept', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

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

  await ctx.createTestImage('base');

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

  await ctx.createTestImage('base');

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

  await ctx.createTestImage('base');

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

  await ctx.createTestImage('base');

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

  await ctx.createTestImage('base');

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

  await ctx.createTestImage('base');

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

  await ctx.createTestImage('base');

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

  await ctx.createTestImage('base');

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

  await ctx.createTestImage('base');

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

  await ctx.createTestImage('base');

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

  await ctx.createTestImage('base');

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

  await ctx.createTestImage('base');

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

  await ctx.createTestImage('base');

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

  await ctx.createTestImage('base');

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

test('it opens a websocket to a granted host with the real credential in place of the placeholder', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const upstream = await startStubBrokerSocketUpstream(ctx.stack, {
    directory: join(ctx.dataDir, 'socket-upstream'),
  });

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: upstream.caPem, upstreams: { 'realtime.example.com': upstream.origin } }),
  );

  await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({
    name: 'rt',
    kind: 'custom',
    value: 'rt-real',
    rules: [buildMockBrokerRule({ host: 'realtime.example.com' })],
  });

  await ctx.impd.broker.addGrant('dev', 'rt');

  const bridge = await startStubBrokerGuestBridge(ctx.stack, {
    proxyPort: ctx.proxyPort,
    address: '127.0.0.2',
  });

  const caPem = await readFile(ctx.caFile, 'utf8');

  const socket = new WebSocket('wss://realtime.example.com/v1/stream', {
    proxy: bridge.proxyURL,
    tls: { ca: [caPem] },
    headers: { authorization: 'Bearer imp-broker-placeholder' },
  });

  ctx.stack.defer(() => {
    socket.close();
  });

  await waitFor(() => {
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  expect(upstream.upgrades).toStrictEqual([
    { path: '/v1/stream', authorization: 'Bearer rt-real', protocols: null },
  ]);
});

test('it passes messages both ways unchanged until the guest closes', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const upstream = await startStubBrokerSocketUpstream(ctx.stack, {
    directory: join(ctx.dataDir, 'socket-upstream'),
  });

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: upstream.caPem, upstreams: { 'realtime.example.com': upstream.origin } }),
  );

  await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({
    name: 'rt',
    kind: 'custom',
    value: 'rt-real',
    rules: [buildMockBrokerRule({ host: 'realtime.example.com' })],
  });

  await ctx.impd.broker.addGrant('dev', 'rt');

  const bridge = await startStubBrokerGuestBridge(ctx.stack, {
    proxyPort: ctx.proxyPort,
    address: '127.0.0.2',
  });

  const caPem = await readFile(ctx.caFile, 'utf8');

  const socket = new WebSocket('wss://realtime.example.com/v1/stream', {
    proxy: bridge.proxyURL,
    tls: { ca: [caPem] },
  });

  socket.binaryType = 'arraybuffer';

  ctx.stack.defer(() => {
    socket.close();
  });

  const echoed: (string | number[])[] = [];

  socket.addEventListener('message', (event: MessageEvent<string | ArrayBuffer>) => {
    const data = typeof event.data === 'string' ? event.data : [...new Uint8Array(event.data)];

    echoed.push(data);
  });

  await waitFor(() => {
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  socket.send('{"type":"session.update"}');
  socket.send(new Uint8Array([0, 1, 254, 255]));

  await waitFor(() => {
    expect(echoed).toHaveLength(2);
  });

  socket.close(1000, 'done');

  await waitFor(() => {
    expect(upstream.closes).toHaveLength(1);
  });

  expect(upstream.received).toStrictEqual([
    '{"type":"session.update"}',
    Buffer.from([0, 1, 254, 255]),
  ]);

  expect(echoed).toStrictEqual(['{"type":"session.update"}', [0, 1, 254, 255]]);
  expect(upstream.closes).toStrictEqual([{ code: 1000, reason: 'done' }]);
});

test('it closes the guest’s websocket with the code the upstream closed with', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const upstream = await startStubBrokerSocketUpstream(ctx.stack, {
    directory: join(ctx.dataDir, 'socket-upstream'),
  });

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: upstream.caPem, upstreams: { 'realtime.example.com': upstream.origin } }),
  );

  await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({
    name: 'rt',
    kind: 'custom',
    value: 'rt-real',
    rules: [buildMockBrokerRule({ host: 'realtime.example.com' })],
  });

  await ctx.impd.broker.addGrant('dev', 'rt');

  const bridge = await startStubBrokerGuestBridge(ctx.stack, {
    proxyPort: ctx.proxyPort,
    address: '127.0.0.2',
  });

  const caPem = await readFile(ctx.caFile, 'utf8');

  const socket = new WebSocket('wss://realtime.example.com/v1/stream', {
    proxy: bridge.proxyURL,
    tls: { ca: [caPem] },
  });

  ctx.stack.defer(() => {
    socket.close();
  });

  const closes: { code: number; reason: string }[] = [];

  socket.addEventListener('close', (event) => {
    closes.push({ code: event.code, reason: event.reason });
  });

  await waitFor(() => {
    expect(upstream.sockets).toHaveLength(1);
  });

  upstream.sockets[0]?.close(4000, 'session over');

  await waitFor(() => {
    expect(closes).toHaveLength(1);
  });

  expect(closes).toStrictEqual([{ code: 4000, reason: 'session over' }]);
});

test('it gives the guest the subprotocol the upstream picked and none of its cookies', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const upstream = await startStubBrokerSocketUpstream(ctx.stack, {
    directory: join(ctx.dataDir, 'socket-upstream'),
    upgradeHeaders: { 'set-cookie': 'edge=abc; Secure', 'x-upstream-trace': 'trace-1' },
  });

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: upstream.caPem, upstreams: { 'realtime.example.com': upstream.origin } }),
  );

  await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({
    name: 'rt',
    kind: 'custom',
    value: 'rt-real',
    rules: [buildMockBrokerRule({ host: 'realtime.example.com' })],
  });

  await ctx.impd.broker.addGrant('dev', 'rt');

  // curl prints the 101 head, then waits on the open socket until --max-time
  const result = await ctx.guest.curl('https://realtime.example.com/v1/stream', [
    '-i',
    '--max-time',
    '1',
    '-H',
    'Connection: Upgrade',
    '-H',
    'Upgrade: websocket',
    '-H',
    'Sec-WebSocket-Version: 13',
    '-H',
    `Sec-WebSocket-Key: ${Buffer.from('imp-test-socket!').toString('base64')}`,
    '-H',
    'Sec-WebSocket-Protocol: realtime, chat.v2',
  ]);

  // the first head is the proxy's answer to the CONNECT
  const head = result.stdout.split('\r\n\r\n')[1]?.toLowerCase().split('\r\n') ?? [];

  expect(head).toIncludeAllMembers([
    'http/1.1 101 switching protocols',
    'sec-websocket-protocol: realtime',
  ]);

  expect(head).not.toContainEqual(expect.toStartWith('set-cookie'));
  expect(head).not.toContainEqual(expect.toStartWith('x-upstream-trace'));

  expect(upstream.upgrades).toStrictEqual([
    { path: '/v1/stream', authorization: 'Bearer rt-real', protocols: 'realtime, chat.v2' },
  ]);
});

test('it records an audit row when a websocket opens and another with its bytes when it closes', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const upstream = await startStubBrokerSocketUpstream(ctx.stack, {
    directory: join(ctx.dataDir, 'socket-upstream'),
  });

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: upstream.caPem, upstreams: { 'realtime.example.com': upstream.origin } }),
  );

  const dev = await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({
    name: 'rt',
    kind: 'custom',
    value: 'rt-real',
    rules: [buildMockBrokerRule({ host: 'realtime.example.com' })],
  });

  await ctx.impd.broker.addGrant('dev', 'rt');

  const bridge = await startStubBrokerGuestBridge(ctx.stack, {
    proxyPort: ctx.proxyPort,
    address: '127.0.0.2',
  });

  const caPem = await readFile(ctx.caFile, 'utf8');

  const socket = new WebSocket('wss://realtime.example.com/v1/stream?token=abc', {
    proxy: bridge.proxyURL,
    tls: { ca: [caPem] },
  });

  ctx.stack.defer(() => {
    socket.close();
  });

  const opened = await waitFor(async () => {
    const listed = await listAuditEntries(ctx.db, dev.id, 10, null);

    expect(listed).toHaveLength(1);

    return listed;
  });

  socket.send('12345');

  await waitFor(() => {
    expect(upstream.received).toHaveLength(1);
  });

  socket.close();

  const all = await waitFor(async () => {
    const listed = await listAuditEntries(ctx.db, dev.id, 10, null);

    expect(listed).toHaveLength(2);

    return listed;
  });

  expect(opened).toStrictEqual([
    {
      at: expect.toBeValidDate(),
      imp: 'dev',
      secret: 'rt',
      method: 'GET',
      host: 'realtime.example.com',
      path: '/v1/stream',
      status: 101,
      requestBytes: 0,
      responseBytes: 0,
      durationMs: expect.toBeNumber(),
    },
  ]);

  expect(all[0]).toStrictEqual({
    at: expect.toBeValidDate(),
    imp: 'dev',
    secret: 'rt',
    method: 'GET',
    host: 'realtime.example.com',
    path: '/v1/stream',
    status: 101,
    requestBytes: 5,
    responseBytes: 5,
    durationMs: expect.toBeNumber(),
  });
});

test('it answers 502 and records the failure when the upstream refuses the websocket', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({
      ca: ctx.upstreamCaPem,
      upstreams: { 'realtime.example.com': ctx.upstreamOrigin },
    }),
  );

  ctx.answers.set('/v1/stream', () => new Response('no key', { status: 401 }));

  const dev = await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({
    name: 'rt',
    kind: 'custom',
    value: 'rt-real',
    rules: [buildMockBrokerRule({ host: 'realtime.example.com' })],
  });

  await ctx.impd.broker.addGrant('dev', 'rt');

  const result = await ctx.guest.curl('https://realtime.example.com/v1/stream', [
    '-H',
    'Connection: Upgrade',
    '-H',
    'Upgrade: websocket',
    '-H',
    'Sec-WebSocket-Version: 13',
    '-H',
    `Sec-WebSocket-Key: ${Buffer.from('imp-test-socket!').toString('base64')}`,
    '-w',
    '%{http_code}',
  ]);

  const entries = await waitFor(async () => {
    const listed = await listAuditEntries(ctx.db, dev.id, 10, null);

    expect(listed).toHaveLength(1);

    return listed;
  });

  expect(result).toStrictEqual({
    code: 0,
    stdout: 'could not open a websocket to realtime.example.com\n502',
    stderr: '',
  });

  expect(entries).toStrictEqual([
    {
      at: expect.toBeValidDate(),
      imp: 'dev',
      secret: 'rt',
      method: 'GET',
      host: 'realtime.example.com',
      path: '/v1/stream',
      status: 502,
      requestBytes: 0,
      responseBytes: 0,
      durationMs: expect.toBeNumber(),
    },
  ]);
});

test('revoking a grant while the service answers the upgrade ends the websocket', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const hold = Promise.withResolvers<void>();

  const upstream = await startStubBrokerSocketUpstream(ctx.stack, {
    directory: join(ctx.dataDir, 'socket-upstream'),
    answerAfter: hold.promise,
  });

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: upstream.caPem, upstreams: { 'realtime.example.com': upstream.origin } }),
  );

  const dev = await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({
    name: 'rt',
    kind: 'custom',
    value: 'rt-real',
    rules: [buildMockBrokerRule({ host: 'realtime.example.com' })],
  });

  await ctx.impd.broker.addGrant('dev', 'rt');

  const bridge = await startStubBrokerGuestBridge(ctx.stack, {
    proxyPort: ctx.proxyPort,
    address: '127.0.0.2',
  });

  const caPem = await readFile(ctx.caFile, 'utf8');

  const socket = new WebSocket('wss://realtime.example.com/v1/stream', {
    proxy: bridge.proxyURL,
    tls: { ca: [caPem] },
  });

  ctx.stack.defer(() => {
    socket.close();
  });

  await waitFor(() => {
    expect(upstream.upgrades).toHaveLength(1);
  });

  // the revoke's pass waits for the upgrade under way, as for any request
  const revoking = ctx.impd.broker.removeGrant('dev', 'rt');

  await waitFor(async () => {
    const names = await listGrantNames(ctx.db, dev.id);

    expect(names).toStrictEqual([]);
  });

  hold.resolve();

  await revoking;

  await waitFor(() => {
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    expect(upstream.closes).toHaveLength(1);
  });
});

test('it renews the leaf of a pair with an open websocket and leaves the websocket open', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const upstream = await startStubBrokerSocketUpstream(ctx.stack, {
    directory: join(ctx.dataDir, 'socket-upstream'),
  });

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: upstream.caPem, upstreams: { 'realtime.example.com': upstream.origin } }),
  );

  await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({
    name: 'rt',
    kind: 'custom',
    value: 'rt-real',
    rules: [buildMockBrokerRule({ host: 'realtime.example.com' })],
  });

  await ctx.impd.broker.addSecret({
    name: 'other',
    kind: 'custom',
    value: 'other-real',
    rules: [buildMockBrokerRule({ host: 'other.example.com' })],
  });

  await ctx.impd.broker.addGrant('dev', 'rt');
  await ctx.impd.broker.addGrant('dev', 'other');

  const bridge = await startStubBrokerGuestBridge(ctx.stack, {
    proxyPort: ctx.proxyPort,
    address: '127.0.0.2',
  });

  const caPem = await readFile(ctx.caFile, 'utf8');

  const socket = new WebSocket('wss://realtime.example.com/v1/stream', {
    proxy: bridge.proxyURL,
    tls: { ca: [caPem] },
  });

  ctx.stack.defer(() => {
    socket.close();
  });

  const echoed: unknown[] = [];

  socket.addEventListener('message', (event: MessageEvent<unknown>) => {
    echoed.push(event.data);
  });

  await waitFor(() => {
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  ctx.clock.nowMs += 340 * 86_400_000;

  // the revoke runs the pass that renews the open pair's leaf
  await ctx.impd.broker.removeGrant('dev', 'other');

  socket.send('still here');

  await waitFor(() => {
    expect(echoed).toStrictEqual(['still here']);
  });
});

test('it closes a websocket whose guest stops reading once the backlog passes 16 MiB', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const upstream = await startStubBrokerSocketUpstream(ctx.stack, {
    directory: join(ctx.dataDir, 'socket-upstream'),
  });

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: upstream.caPem, upstreams: { 'realtime.example.com': upstream.origin } }),
  );

  await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({
    name: 'rt',
    kind: 'custom',
    value: 'rt-real',
    rules: [buildMockBrokerRule({ host: 'realtime.example.com' })],
  });

  await ctx.impd.broker.addGrant('dev', 'rt');

  const caPem = await readFile(ctx.caFile, 'utf8');

  const bridge = await startStubBrokerGuestBridge(ctx.stack, {
    proxyPort: ctx.proxyPort,
    address: '127.0.0.2',
  });

  const guest = await startStubPausedSocketGuest(ctx.stack, {
    port: Number(new URL(bridge.proxyURL).port),
    host: 'realtime.example.com',
    path: '/v1/stream',
    tunnel: { ca: caPem },
  });

  await waitFor(() => {
    expect(upstream.sockets).toHaveLength(1);
  });

  const chunk = Buffer.alloc(1024 * 1024, 7);

  // one MiB each poll: the service's own buffer drops what the broker has
  // not taken yet, so it sends until the broker closes
  await waitFor(() => {
    upstream.sockets[0]?.send(chunk);
    expect(upstream.closes).toHaveLength(1);
  });

  guest.resume();

  await guest.closed;

  expect(guest.head).toStartWith('HTTP/1.1 101 ');
});

test('revoking a grant closes its open websockets', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const upstream = await startStubBrokerSocketUpstream(ctx.stack, {
    directory: join(ctx.dataDir, 'socket-upstream'),
  });

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: upstream.caPem, upstreams: { 'realtime.example.com': upstream.origin } }),
  );

  await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({
    name: 'rt',
    kind: 'custom',
    value: 'rt-real',
    rules: [buildMockBrokerRule({ host: 'realtime.example.com' })],
  });

  await ctx.impd.broker.addGrant('dev', 'rt');

  const bridge = await startStubBrokerGuestBridge(ctx.stack, {
    proxyPort: ctx.proxyPort,
    address: '127.0.0.2',
  });

  const caPem = await readFile(ctx.caFile, 'utf8');

  const socket = new WebSocket('wss://realtime.example.com/v1/stream', {
    proxy: bridge.proxyURL,
    tls: { ca: [caPem] },
  });

  ctx.stack.defer(() => {
    socket.close();
  });

  const closes: { code: number; reason: string }[] = [];

  socket.addEventListener('close', (event) => {
    closes.push({ code: event.code, reason: event.reason });
  });

  await waitFor(() => {
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  await ctx.impd.broker.removeGrant('dev', 'rt');

  await waitFor(() => {
    expect(closes).toHaveLength(1);
    expect(upstream.closes).toHaveLength(1);
  });

  expect(closes).toStrictEqual([{ code: 1008, reason: 'the grant is gone' }]);
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
