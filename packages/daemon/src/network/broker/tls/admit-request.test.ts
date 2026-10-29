import { expect, mock, test } from 'bun:test';
import invariant from 'tiny-invariant';
import { buildMockCredential } from '../../../../testing/network/build-mock-credential';
import type { NewAuditEntry } from '../../../platform/db/broker-audit';
import { admitRequest } from './admit-request';

test('it admits a request for its host with the granted credential', async () => {
  const credential = buildMockCredential({ secretName: 'gh' });

  const admission = await admitRequest(
    {
      impId: 'imp-1',
      impName: 'dev',
      host: 'api.example.com',
      findCredential: () => Promise.resolve(credential),
      recordAudit: () => {},
    },
    new Request('https://api.example.com/v1/models?limit=2', {
      headers: { host: 'api.example.com' },
    }),
    performance.now(),
    'request',
  );

  invariant(admission.kind === 'admitted');

  expect(admission.credential).toBe(credential);
  expect(admission.auditPath).toBe('/v1/models');
});

test.each([
  [
    'request',
    'GET',
    'https://api.example.com/user',
    { authorization: 'Bearer imp-broker-placeholder' },
  ],
  ['request', 'POST', 'https://api.example.com/v1/chat', { 'content-type': 'application/json' }],
  ['request', 'DELETE', 'https://api.example.com/repos/a/b', {}],
  ['request', 'GET', 'https://api.example.com:443/user', {}],
  ['upgrade', 'GET', 'https://api.example.com/v1/realtime', { upgrade: 'websocket' }],
] as const)(
  'it refuses a %s for %s %s with no granted credential, and records no secret',
  async (kind, method, url, headers) => {
    const recordAudit = mock<(entry: NewAuditEntry) => void>();

    const admission = await admitRequest(
      {
        impId: 'imp-1',
        impName: 'dev',
        host: 'api.example.com',
        findCredential: () => Promise.resolve(null),
        recordAudit,
      },
      new Request(url, { method, headers: { host: 'api.example.com', ...headers } }),
      performance.now(),
      kind,
    );

    invariant(admission.kind === 'refused');

    expect(admission.response.status).toBe(403);

    expect(recordAudit).toHaveBeenCalledExactlyOnceWith({
      impId: 'imp-1',
      impName: 'dev',
      secretName: null,
      at: expect.toBeValidDate(),
      method,
      host: 'api.example.com',
      path: new URL(url).pathname,
      status: 403,
      requestBytes: 0,
      responseBytes: 0,
      durationMs: expect.toBeNumber(),
      reason: 'no-grant',
    });
  },
);

test('it admits a request inside the grant’s filter', async () => {
  const admission = await admitRequest(
    {
      impId: 'imp-1',
      impName: 'dev',
      host: 'api.example.com',
      findCredential: () =>
        Promise.resolve(
          buildMockCredential({ filter: { methods: ['GET'], paths: ['/repos/*/*/issues'] } }),
        ),
      recordAudit: () => {},
    },
    new Request('https://api.example.com/repos/acme/app/issues', {
      headers: { host: 'api.example.com' },
    }),
    performance.now(),
    'request',
  );

  expect(admission.kind).toBe('admitted');
});

test.each([
  ['request', 'POST', 'https://api.example.com/repos/acme/app/issues', '/repos/acme/app/issues'],
  ['request', 'DELETE', 'https://api.example.com/repos/acme/app/issues', '/repos/acme/app/issues'],
  ['request', 'GET', 'https://api.example.com/repos/acme/app/pulls', '/repos/acme/app/pulls'],
  ['request', 'GET', 'https://api.example.com/repos/acme/issues', '/repos/acme/issues'],
  ['request', 'GET', 'https://api.example.com/repos/acme/app/issues/1', '/repos/acme/app/issues/1'],
  ['request', 'GET', 'https://api.example.com/repos//app/issues', '/repos//app/issues'],
  [
    'request',
    'GET',
    'https://api.example.com/repos/acme%2fapp/x/issues',
    '/repos/acme%2fapp/x/issues',
  ],
  ['request', 'GET', 'https://api.example.com/repos/a/b/../../../admin', '/admin'],
  ['request', 'GET', 'https://api.example.com/REPOS/acme/app/issues', '/REPOS/acme/app/issues'],
  ['upgrade', 'GET', 'https://api.example.com/repos/acme/app/pulls', '/repos/acme/app/pulls'],
] as const)(
  'it refuses a %s for %s %s outside the grant’s filter',
  async (kind, method, url, path) => {
    const recordAudit = mock<(entry: NewAuditEntry) => void>();

    const admission = await admitRequest(
      {
        impId: 'imp-1',
        impName: 'dev',
        host: 'api.example.com',
        findCredential: () =>
          Promise.resolve(
            buildMockCredential({ filter: { methods: ['GET'], paths: ['/repos/*/*/issues'] } }),
          ),
        recordAudit,
      },
      new Request(url, { method, headers: { host: 'api.example.com' } }),
      performance.now(),
      kind,
    );

    invariant(admission.kind === 'refused');

    expect(admission.response.status).toBe(403);

    expect(recordAudit).toHaveBeenCalledExactlyOnceWith({
      impId: 'imp-1',
      impName: 'dev',
      secretName: null,
      at: expect.toBeValidDate(),
      method,
      host: 'api.example.com',
      path,
      status: 403,
      requestBytes: 0,
      responseBytes: 0,
      durationMs: expect.toBeNumber(),
      reason: 'outside-filter',
    });
  },
);
