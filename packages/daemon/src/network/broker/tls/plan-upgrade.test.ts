import { expect, mock, test } from 'bun:test';
import invariant from 'tiny-invariant';
import { buildMockCredential } from '../../../../testing/network/build-mock-credential';
import type { NewAuditEntry } from '../../../platform/db/broker-audit';
import { planUpgrade } from './plan-upgrade';

test('it adds the real credential to the upgrade and keeps its Upgrade and Connection headers', async () => {
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
        'sec-websocket-key': Buffer.from('imp-test-socket!').toString('base64'),
        'sec-websocket-version': '13',
        'proxy-authorization': 'Basic Z3Vlc3Q6cHJveHk=',
      },
    }),
  );

  invariant(plan.kind === 'open');

  expect(plan.url).toBe('https://realtime.example.com/v1/stream?model=small');
  expect(plan.ca).toBeNull();

  expect(Object.fromEntries(plan.headers)).toStrictEqual({
    authorization: 'Bearer real',
    connection: 'Upgrade',
    upgrade: 'websocket',
    'sec-websocket-key': Buffer.from('imp-test-socket!').toString('base64'),
    'sec-websocket-version': '13',
  });
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

  expect(plan.url).toBe('http://172.17.0.1:18081/socket');
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

  expect(plan.url).toBe('https://upstream.test:9443/socket');
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

  expect(Object.fromEntries(plan.headers)).toStrictEqual({
    'x-api-key': 'real-key',
    connection: 'Upgrade',
    upgrade: 'websocket',
  });
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

test('it records one audit row for the connection when it closes, with the bytes each way', async () => {
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

  plan.audit.addRequestBytes(5);
  plan.audit.addResponseBytes(40);
  plan.audit.addRequestBytes(7);
  plan.audit.recordClose(101);
  plan.audit.recordClose(101);

  expect(recordAudit).toHaveBeenCalledExactlyOnceWith({
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

test('it records nothing for an open connection', async () => {
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

  plan.audit.addRequestBytes(5);

  expect(recordAudit).not.toHaveBeenCalled();
});
