import { expect, mock, onTestFinished, setSystemTime, test } from 'bun:test';
import invariant from 'tiny-invariant';
import { buildMockCredential } from '../../../../testing/network/build-mock-credential';
import type { NewAuditEntry } from '../../../platform/db/broker-audit';
import { planUpgrade } from './plan-upgrade';

test('it adds the real credential to the upgrade and leaves the handshake to the upstream client', async () => {
  const plan = await planUpgrade(
    {
      impId: 'imp-1',
      impName: 'dev',
      host: 'realtime.example.com',
      findCredential: () =>
        Promise.resolve(
          buildMockCredential({ secretName: 'rt', header: 'authorization', value: 'Bearer real' }),
        ),
      resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
      recordAudit: () => {},
    },
    new Request('https://realtime.example.com/v1/stream?model=small', {
      headers: {
        host: 'realtime.example.com',
        authorization: 'Bearer imp-broker-placeholder',
        connection: 'keep-alive, Upgrade',
        upgrade: 'websocket',
        origin: 'https://app.example.com',
        'sec-websocket-key': Buffer.from('imp-test-socket!').toString('base64'),
        'sec-websocket-version': '13',
        'sec-websocket-extensions': 'permessage-deflate',
        'sec-websocket-protocol': 'realtime',
        'proxy-authorization': 'Basic Z3Vlc3Q6cHJveHk=',
      },
    }),
  );

  invariant(plan.kind === 'open');

  expect(plan.url).toBe('wss://realtime.example.com/v1/stream?model=small');
  expect(plan.ca).toBeNull();

  expect(Object.fromEntries(plan.headers)).toStrictEqual({
    authorization: 'Bearer real',
    origin: 'https://app.example.com',
  });
});

test('it skips a name in the Connection header that can name no header', async () => {
  const plan = await planUpgrade(
    {
      impId: 'imp-1',
      impName: 'dev',
      host: 'realtime.example.com',
      findCredential: () =>
        Promise.resolve(buildMockCredential({ header: 'x-api-key', value: 'real-key' })),
      resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
      recordAudit: () => {},
    },
    new Request('https://realtime.example.com/socket', {
      headers: {
        host: 'realtime.example.com',
        connection: 'Upgrade, bad name, x-trace',
        upgrade: 'websocket',
        'x-trace': 'abc',
        'x-keep': 'kept',
      },
    }),
  );

  invariant(plan.kind === 'open');

  expect(Object.fromEntries(plan.headers)).toStrictEqual({
    'x-api-key': 'real-key',
    'x-keep': 'kept',
  });
});

test('it offers the upstream the guest’s subprotocols in order', async () => {
  const plan = await planUpgrade(
    {
      impId: 'imp-1',
      impName: 'dev',
      host: 'realtime.example.com',
      findCredential: () => Promise.resolve(buildMockCredential()),
      resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
      recordAudit: () => {},
    },
    new Request('https://realtime.example.com/socket', {
      headers: {
        host: 'realtime.example.com',
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-protocol': 'realtime, , chat.v2',
      },
    }),
  );

  invariant(plan.kind === 'open');

  expect(plan.protocols).toStrictEqual(['realtime', 'chat.v2']);
});

test('it sends the upgrade to the rule’s upstream', async () => {
  const plan = await planUpgrade(
    {
      impId: 'imp-1',
      impName: 'dev',
      host: 'realtime.internal',
      findCredential: () =>
        Promise.resolve(buildMockCredential({ upstream: 'http://172.17.0.1:18081' })),
      resolveUpstream: (host) => ({ origin: `https://${host}`, ca: ['TEST CA'] }),
      recordAudit: () => {},
    },
    new Request('https://realtime.internal/socket', {
      headers: { host: 'realtime.internal', connection: 'Upgrade', upgrade: 'websocket' },
    }),
  );

  invariant(plan.kind === 'open');

  expect(plan.url).toBe('ws://172.17.0.1:18081/socket');
  expect(plan.ca).toBeNull();
});

test('it sends the upgrade to a test upstream with its CA', async () => {
  const plan = await planUpgrade(
    {
      impId: 'imp-1',
      impName: 'dev',
      host: 'realtime.example.com',
      findCredential: () => Promise.resolve(buildMockCredential()),
      resolveUpstream: () => ({ origin: 'https://upstream.test:9443', ca: ['TEST CA'] }),
      recordAudit: () => {},
    },
    new Request('https://realtime.example.com/socket', {
      headers: { host: 'realtime.example.com', connection: 'Upgrade', upgrade: 'websocket' },
    }),
  );

  invariant(plan.kind === 'open');

  expect(plan.url).toBe('wss://upstream.test:9443/socket');
  expect(plan.ca).toStrictEqual(['TEST CA']);
});

test('it drops the method-override headers from an upgrade under a filtered grant', async () => {
  const plan = await planUpgrade(
    {
      impId: 'imp-1',
      impName: 'dev',
      host: 'realtime.example.com',
      findCredential: () =>
        Promise.resolve(
          buildMockCredential({
            header: 'x-api-key',
            value: 'real-key',
            filter: { methods: ['GET'], paths: ['/socket'] },
          }),
        ),
      resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
      recordAudit: () => {},
    },
    new Request('https://realtime.example.com/socket', {
      headers: {
        host: 'realtime.example.com',
        connection: 'Upgrade',
        upgrade: 'websocket',
        'x-http-method-override': 'DELETE',
      },
    }),
  );

  invariant(plan.kind === 'open');

  expect(Object.fromEntries(plan.headers)).toStrictEqual({ 'x-api-key': 'real-key' });
});

test('it refuses an upgrade with no grant with 403 and a refused audit row', async () => {
  const recordAudit = mock<(entry: NewAuditEntry) => void>();

  const plan = await planUpgrade(
    {
      impId: 'imp-1',
      impName: 'dev',
      host: 'realtime.example.com',
      findCredential: () => Promise.resolve(null),
      resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
      recordAudit,
    },
    new Request('https://realtime.example.com/socket?token=abc', {
      headers: { host: 'realtime.example.com', connection: 'Upgrade', upgrade: 'websocket' },
    }),
  );

  invariant(plan.kind === 'refused');

  const text = await plan.response.text();

  expect(plan.response.status).toBe(403);
  expect(text).toBe('no credential is granted for realtime.example.com\n');

  expect(recordAudit).toHaveBeenCalledExactlyOnceWith({
    impId: 'imp-1',
    impName: 'dev',
    secretName: null,
    at: expect.toBeValidDate(),
    method: 'GET',
    host: 'realtime.example.com',
    path: '/socket',
    status: 403,
    requestBytes: 0,
    responseBytes: 0,
    durationMs: expect.toBeNumber(),
    reason: 'no-grant',
  });
});

test('it refuses an upgrade outside the grant’s filter with 403', async () => {
  const plan = await planUpgrade(
    {
      impId: 'imp-1',
      impName: 'dev',
      host: 'realtime.example.com',
      findCredential: () =>
        Promise.resolve(buildMockCredential({ filter: { methods: ['GET'], paths: ['/v1/*'] } })),
      resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
      recordAudit: () => {},
    },
    new Request('https://realtime.example.com/admin/socket', {
      headers: { host: 'realtime.example.com', connection: 'Upgrade', upgrade: 'websocket' },
    }),
  );

  invariant(plan.kind === 'refused');

  const text = await plan.response.text();

  expect(plan.response.status).toBe(403);
  expect(text).toBe('the grant for realtime.example.com does not cover GET /admin/socket\n');
});

test('it refuses an upgrade that is not a GET with 400 before it reads the grant', async () => {
  const recordAudit = mock<(entry: NewAuditEntry) => void>();

  const findCredential = mock(() =>
    Promise.resolve(buildMockCredential({ filter: { methods: ['POST'] } })),
  );

  const plan = await planUpgrade(
    {
      impId: 'imp-1',
      impName: 'dev',
      host: 'realtime.example.com',
      findCredential,
      resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
      recordAudit,
    },
    new Request('https://realtime.example.com/socket', {
      method: 'POST',
      headers: { host: 'realtime.example.com', connection: 'Upgrade', upgrade: 'websocket' },
    }),
  );

  invariant(plan.kind === 'refused');

  const text = await plan.response.text();

  expect(plan.response.status).toBe(400);
  expect(text).toBe('a websocket upgrade must be a GET\n');
  expect(findCredential).not.toHaveBeenCalled();

  expect(recordAudit).toHaveBeenCalledExactlyOnceWith({
    impId: 'imp-1',
    impName: 'dev',
    secretName: null,
    at: expect.toBeValidDate(),
    method: 'POST',
    host: 'realtime.example.com',
    path: '/socket',
    status: 400,
    requestBytes: 0,
    responseBytes: 0,
    durationMs: expect.toBeNumber(),
    reason: 'websocket',
  });
});

test('it refuses an upgrade with a Host header for another name with 421', async () => {
  const findCredential = mock(() => Promise.resolve(buildMockCredential()));

  const plan = await planUpgrade(
    {
      impId: 'imp-1',
      impName: 'dev',
      host: 'realtime.example.com',
      findCredential,
      resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
      recordAudit: () => {},
    },
    new Request('https://other.example.com/socket', {
      headers: { host: 'other.example.com', connection: 'Upgrade', upgrade: 'websocket' },
    }),
  );

  invariant(plan.kind === 'refused');

  expect(plan.response.status).toBe(421);
  expect(findCredential).not.toHaveBeenCalled();
});

test('it records a 101 row with no bytes when the connection opens', async () => {
  const recordAudit = mock<(entry: NewAuditEntry) => void>();

  const plan = await planUpgrade(
    {
      impId: 'imp-1',
      impName: 'dev',
      host: 'realtime.example.com',
      findCredential: () => Promise.resolve(buildMockCredential({ secretName: 'rt' })),
      resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
      recordAudit,
    },
    new Request('https://realtime.example.com/v1/stream?token=abc', {
      headers: { host: 'realtime.example.com', connection: 'Upgrade', upgrade: 'websocket' },
    }),
  );

  invariant(plan.kind === 'open');

  plan.audit.recordOpen();
  plan.audit.addRequestBytes(5);

  expect(recordAudit).toHaveBeenCalledExactlyOnceWith({
    impId: 'imp-1',
    impName: 'dev',
    secretName: 'rt',
    at: expect.toBeValidDate(),
    method: 'GET',
    host: 'realtime.example.com',
    path: '/v1/stream',
    status: 101,
    requestBytes: 0,
    responseBytes: 0,
    durationMs: expect.toBeNumber(),
    reason: null,
  });
});

test('it records a second 101 row with the bytes each way when the connection closes', async () => {
  const recordAudit = mock<(entry: NewAuditEntry) => void>();

  const plan = await planUpgrade(
    {
      impId: 'imp-1',
      impName: 'dev',
      host: 'realtime.example.com',
      findCredential: () => Promise.resolve(buildMockCredential({ secretName: 'rt' })),
      resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
      recordAudit,
    },
    new Request('https://realtime.example.com/v1/stream', {
      headers: { host: 'realtime.example.com', connection: 'Upgrade', upgrade: 'websocket' },
    }),
  );

  invariant(plan.kind === 'open');

  plan.audit.recordOpen();
  plan.audit.addRequestBytes(5);
  plan.audit.addResponseBytes(40);
  plan.audit.addRequestBytes(7);
  plan.audit.recordClose();

  expect(recordAudit).toHaveBeenCalledTimes(2);

  expect(recordAudit).toHaveBeenLastCalledWith({
    impId: 'imp-1',
    impName: 'dev',
    secretName: 'rt',
    at: expect.toBeValidDate(),
    method: 'GET',
    host: 'realtime.example.com',
    path: '/v1/stream',
    status: 101,
    requestBytes: 12,
    responseBytes: 40,
    durationMs: expect.toBeNumber(),
    reason: null,
  });
});

test('it records the close of a connection once', async () => {
  const recordAudit = mock<(entry: NewAuditEntry) => void>();

  const plan = await planUpgrade(
    {
      impId: 'imp-1',
      impName: 'dev',
      host: 'realtime.example.com',
      findCredential: () => Promise.resolve(buildMockCredential()),
      resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
      recordAudit,
    },
    new Request('https://realtime.example.com/socket', {
      headers: { host: 'realtime.example.com', connection: 'Upgrade', upgrade: 'websocket' },
    }),
  );

  invariant(plan.kind === 'open');

  plan.audit.recordOpen();
  plan.audit.recordClose();
  plan.audit.recordClose();

  expect(recordAudit).toHaveBeenCalledTimes(2);
});

test('it times the close row from the open row, so the open row’s time is the close row’s time minus its duration', async () => {
  onTestFinished(() => {
    setSystemTime();
  });

  const recordAudit = mock<(entry: NewAuditEntry) => void>();

  setSystemTime(new Date('2026-03-01T10:00:00.000Z'));

  const plan = await planUpgrade(
    {
      impId: 'imp-1',
      impName: 'dev',
      host: 'realtime.example.com',
      findCredential: () => Promise.resolve(buildMockCredential({ secretName: 'rt' })),
      resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
      recordAudit,
    },
    new Request('https://realtime.example.com/socket', {
      headers: { host: 'realtime.example.com', connection: 'Upgrade', upgrade: 'websocket' },
    }),
  );

  invariant(plan.kind === 'open');
  setSystemTime(new Date('2026-03-01T10:00:03.000Z'));

  plan.audit.recordOpen();

  setSystemTime(new Date('2026-03-01T10:01:03.000Z'));

  plan.audit.recordClose();

  expect(recordAudit.mock.calls.map((call) => [call[0].at, call[0].durationMs])).toStrictEqual([
    [new Date('2026-03-01T10:00:03.000Z'), 3000],
    [new Date('2026-03-01T10:01:03.000Z'), 60_000],
  ]);
});

test('it records one row with the upstream’s status when the upstream does not switch', async () => {
  const recordAudit = mock<(entry: NewAuditEntry) => void>();

  const plan = await planUpgrade(
    {
      impId: 'imp-1',
      impName: 'dev',
      host: 'realtime.example.com',
      findCredential: () => Promise.resolve(buildMockCredential({ secretName: 'rt' })),
      resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
      recordAudit,
    },
    new Request('https://realtime.example.com/socket', {
      headers: { host: 'realtime.example.com', connection: 'Upgrade', upgrade: 'websocket' },
    }),
  );

  invariant(plan.kind === 'open');

  plan.audit.recordAnswer(401);
  plan.audit.recordClose();

  expect(recordAudit).toHaveBeenCalledExactlyOnceWith({
    impId: 'imp-1',
    impName: 'dev',
    secretName: 'rt',
    at: expect.toBeValidDate(),
    method: 'GET',
    host: 'realtime.example.com',
    path: '/socket',
    status: 401,
    requestBytes: 0,
    responseBytes: 0,
    durationMs: expect.toBeNumber(),
    reason: null,
  });
});
