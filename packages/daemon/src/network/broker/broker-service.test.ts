import { expect, onTestFinished, test } from 'bun:test';
import { access, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { connect as connectTls } from 'node:tls';
import { buildMockBrokerRule } from '@impz/api/test-utils/build-mock-broker-rule';
import { server } from '@impz/test-utils/mock-server';
import { waitFor } from '@impz/test-utils/wait-for';
import { HttpResponse, http } from 'msw';
import invariant from 'tiny-invariant';
import { buildStubHostRoutes } from '../../../testing/host-net/build-stub-host-routes';
import { startStubBrokerGuestSocket } from '../../../testing/network/start-stub-broker-guest-socket';
import { startStubBrokerReplyTarget } from '../../../testing/network/start-stub-broker-reply-target';
import { buildMockNewAuditEntry } from '../../../testing/platform/build-mock-new-audit-entry';
import { runSql } from '../../../testing/platform/run-sql';
import { startTestImpd } from '../../../testing/start-test-impd';
import { parsePrefix64 } from '../../host-net/net/addressing6';
import { createReachPolicy } from '../../host-net/net/reach-policy';
import {
  AUDIT_ROWS_PER_IMP,
  listAuditEntries,
  listRefusedRequests,
  writeAuditEntry,
} from '../../platform/db/broker-audit';
import { readImpByName, updateImpMove } from '../../platform/db/imps';
import { readSecret } from '../../platform/db/secrets';
import { createBroker } from './broker-service';
import { resolvePublicUpstream } from './tls/resolve-public-upstream';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const installs: string[] = [];

  const harness = await startTestImpd(stack, {
    env: { IMP_SUBNET: '127.0.0.0/16' },

    installBundle: (vsockPath) => {
      installs.push(vsockPath);

      return access(vsockPath);
    },
  });

  return Object.assign(harness, { stack, installs });
}

test('it stores a secret value in an owner-only file the row names', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });

  const secret = await readSecret(ctx.db, 'gh');

  invariant(secret);

  const path = join(ctx.dataDir, 'secrets', secret.valueFile);

  const value = await readFile(path, 'utf8');
  const stats = await stat(path);

  expect(value).toBe('ghp_SECRETVALUE0123456789');
  expect(stats.mode & 0o777).toBe(0o600);
});

test('it answers an added secret with its hosts and no value', async () => {
  const ctx = await setupTest();

  const added: unknown = await ctx.client.secrets.add({
    name: 'gh',
    preset: 'github',
    value: 'ghp_SECRETVALUE0123456789',
  });

  expect(added).toStrictEqual({
    name: 'gh',
    kind: 'static',
    rules: [
      { host: 'github.com', header: 'authorization', scheme: 'basic', user: 'x-access-token' },
      { host: 'api.github.com', header: 'authorization', scheme: 'bearer' },
      { host: 'uploads.github.com', header: 'authorization', scheme: 'bearer' },
    ],
    env: ['GH_TOKEN', 'GITHUB_TOKEN'],
    imps: [],
    createdAt: expect.any(Date) as unknown,
    droppedGrants: 0,
  });
});

test('it never shows a granted value through the API', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  const everything = JSON.stringify([
    await ctx.client.secrets.list(),
    await ctx.client.grants.list({ name: 'dev' }),
    await ctx.client.imps.list(),
    await ctx.client.imps.get({ name: 'dev' }),
    await ctx.client.system.info(),
  ]);

  expect(everything).not.toInclude('ghp_SECRETVALUE0123456789');
});

test('it lists a secret with the imps it is granted to', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  const secrets: unknown = await ctx.client.secrets.list();

  expect(secrets).toStrictEqual([
    {
      name: 'gh',
      kind: 'static',
      rules: [
        { host: 'github.com', header: 'authorization', scheme: 'basic', user: 'x-access-token' },
        { host: 'api.github.com', header: 'authorization', scheme: 'bearer' },
        { host: 'uploads.github.com', header: 'authorization', scheme: 'bearer' },
      ],
      env: ['GH_TOKEN', 'GITHUB_TOKEN'],
      imps: ['dev'],
      createdAt: expect.any(Date) as unknown,
    },
  ]);
});

test.each([['../etc'], ['a/b'], ['.hidden'], ['Upper'], ['']])(
  'it rejects the secret name %p before it reaches the disk',
  async (name) => {
    const ctx = await setupTest();

    expect(
      ctx.client.secrets.add({ name, kind: 'github', value: 'ghp_SECRETVALUE0123456789' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  },
);

test('it rejects a value that could split a header', async () => {
  const ctx = await setupTest();

  expect(
    ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'a\r\nx-evil: 1' }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});

test('it rejects a static secret with an empty rule list', async () => {
  const ctx = await setupTest();

  expect(
    ctx.client.secrets.add({
      name: 'api',
      kind: 'static',
      value: 'ghp_SECRETVALUE0123456789',
      rules: [],
    }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});

test('it refuses a taken name without replace and keeps the stored value', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });

  const taken = ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'other' });

  expect(taken).rejects.toMatchObject({ code: 'CONFLICT' });

  const secret = await readSecret(ctx.db, 'gh');

  invariant(secret);

  const value = await readFile(join(ctx.dataDir, 'secrets', secret.valueFile), 'utf8');

  expect(value).toBe('ghp_SECRETVALUE0123456789');
});

test('it writes a replace to a new file and removes the old one', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'rotated', replace: true });

  const secret = await readSecret(ctx.db, 'gh');

  invariant(secret);

  const files = await readdir(join(ctx.dataDir, 'secrets'));
  const value = await readFile(join(ctx.dataDir, 'secrets', secret.valueFile), 'utf8');

  expect(files).toStrictEqual([secret.valueFile]);
  expect(value).toBe('rotated');
});

test('it keeps the value out of the error and the log when its write fails', async () => {
  const ctx = await setupTest();

  // a file where the directory goes: the write fails, even as root
  await rm(join(ctx.dataDir, 'secrets'), { recursive: true });
  await writeFile(join(ctx.dataDir, 'secrets'), '');

  const added = ctx.impd.broker.addSecret({
    name: 'gh',
    kind: 'github',
    value: 'ghp_SECRETVALUE0123456789',
  });

  expect(added).rejects.toSatisfy(
    (thrown: unknown) =>
      thrown instanceof Error &&
      !`${String(thrown)} ${JSON.stringify(thrown)}`.includes('ghp_SECRETVALUE0123456789'),
  );

  expect(ctx.logs.join('\n')).not.toInclude('ghp_SECRETVALUE0123456789');
});

test('it keeps the value out of the API’s error and impd’s log when its write fails', async () => {
  const ctx = await setupTest();

  // a file where the directory goes: the write fails, even as root
  await rm(join(ctx.dataDir, 'secrets'), { recursive: true });
  await writeFile(join(ctx.dataDir, 'secrets'), '');

  const added = ctx.client.secrets.add({
    name: 'gh',
    kind: 'github',
    value: 'ghp_SECRETVALUE0123456789',
  });

  expect(added).rejects.toSatisfy(
    (thrown: unknown) =>
      thrown instanceof Error &&
      !`${String(thrown)} ${JSON.stringify(thrown)}`.includes('ghp_SECRETVALUE0123456789'),
  );

  expect(ctx.logs.join('\n')).not.toInclude('ghp_SECRETVALUE0123456789');
});

test('it logs a failed write in the API’s log without the value', async () => {
  const ctx = await setupTest();

  // a file where the directory goes: the write fails, even as root
  await rm(join(ctx.dataDir, 'secrets'), { recursive: true });
  await writeFile(join(ctx.dataDir, 'secrets'), '');

  const added = ctx.client.secrets.add({
    name: 'gh',
    kind: 'github',
    value: 'ghp_SECRETVALUE0123456789',
  });

  expect(added).rejects.toThrow();

  const logged = ctx.rpcFailures.map((failure) => Bun.inspect(failure));

  expect(logged).toHaveLength(1);
  expect(logged).toSatisfyAll((line: string) => !line.includes('ghp_SECRETVALUE0123456789'));
});

test('it leaves no row behind when the value cannot be written', async () => {
  const ctx = await setupTest();

  // a file where the directory goes: the write fails, even as root
  await rm(join(ctx.dataDir, 'secrets'), { recursive: true });
  await writeFile(join(ctx.dataDir, 'secrets'), '');

  const added = ctx.impd.broker.addSecret({
    name: 'gh',
    kind: 'github',
    value: 'ghp_SECRETVALUE0123456789',
  });

  expect(added).rejects.toThrow();

  const left = await ctx.client.secrets.list();

  expect(left).toStrictEqual([]);
});

test('it rejects a grant to an imp that does not exist', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });

  expect(ctx.client.grants.add({ name: 'nope', secret: 'gh' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'imp' },
  });
});

test('it rejects a grant of a secret that does not exist', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });

  expect(ctx.client.grants.add({ name: 'dev', secret: 'nope' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'secret' },
  });
});

test('it rejects a second credential for a host the imp already has one for', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });

  await ctx.client.secrets.add({
    name: 'gh-api',
    kind: 'custom',
    value: 'ghp_SECRETVALUE0123456789',
    rules: [buildMockBrokerRule({ host: 'api.github.com' })],
  });

  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  expect(ctx.client.grants.add({ name: 'dev', secret: 'gh-api' })).rejects.toMatchObject({
    code: 'CONFLICT',
    message: 'secret gh already gives dev a credential for api.github.com',
  });
});

test('it rejects a revoke of a grant that is not there', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });

  expect(ctx.client.grants.delete({ name: 'dev', secret: 'gh' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'grant' },
  });
});

test('it refuses a revoke on an imp that is moving', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const dev = await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  await updateImpMove(ctx.db, dev.id, 'receiving');

  expect(ctx.impd.broker.removeGrant('dev', 'gh')).rejects.toMatchObject({ code: 'MOVING' });
});

test('it copies the grants of the source to a fork', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });

  await ctx.client.secrets.add({
    name: 'claude',
    kind: 'anthropic',
    value: 'ghp_SECRETVALUE0123456789',
  });

  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });
  await ctx.client.grants.add({ name: 'dev', secret: 'claude' });
  await ctx.client.imps.fork({ source: 'dev', name: 'copy' });

  const copied = await ctx.client.grants.list({ name: 'copy' });

  expect(copied).toStrictEqual(['claude', 'gh']);
});

test('it copies each grant’s filter to a fork', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'npm_SECRETVALUE0123456789' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh', filter: { methods: ['GET'] } });
  await ctx.client.grants.add({ name: 'dev', secret: 'npm' });
  await ctx.client.imps.fork({ source: 'dev', name: 'copy' });

  const copied = await ctx.client.grants.details({ name: 'copy' });

  expect(copied).toStrictEqual([
    { secret: 'gh', filter: { methods: ['GET'] } },
    { secret: 'npm', filter: null },
  ]);
});

test('it lists each grant with its filter, and null for a grant of the whole host', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'npm_SECRETVALUE0123456789' });

  await ctx.client.grants.add({
    name: 'dev',
    secret: 'gh',
    filter: { methods: ['GET', 'HEAD'], paths: ['/repos/*/*/issues', '/user'] },
  });

  await ctx.client.grants.add({ name: 'dev', secret: 'npm' });

  const grants = await ctx.client.grants.details({ name: 'dev' });

  expect(grants).toStrictEqual([
    { secret: 'gh', filter: { methods: ['GET', 'HEAD'], paths: ['/repos/*/*/issues', '/user'] } },
    { secret: 'npm', filter: null },
  ]);
});

test('it lists a filtered grant by name alone, as an older client reads grants', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh', filter: { methods: ['GET'] } });

  const names = await ctx.client.grants.list({ name: 'dev' });

  expect(names).toStrictEqual(['gh']);
});

test('it keeps a grant’s filter when the grant is made again without one', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh', filter: { methods: ['GET'] } });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  const grants = await ctx.client.grants.details({ name: 'dev' });

  expect(grants).toStrictEqual([{ secret: 'gh', filter: { methods: ['GET'] } }]);
});

test('it replaces a grant’s filter with the one a new grant call gives', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh', filter: { methods: ['GET'] } });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh', filter: { paths: ['/user'] } });

  const grants = await ctx.client.grants.details({ name: 'dev' });

  expect(grants).toStrictEqual([{ secret: 'gh', filter: { paths: ['/user'] } }]);
});

test('it refuses a grant whose filter names neither methods nor paths', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });

  expect(ctx.client.grants.add({ name: 'dev', secret: 'gh', filter: {} })).rejects.toMatchObject({
    code: 'BAD_REQUEST',
  });
});

test('it takes the grants and the value file of a deleted secret along', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });

  await ctx.client.secrets.add({
    name: 'claude',
    kind: 'anthropic',
    value: 'ghp_SECRETVALUE0123456789',
  });

  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });
  await ctx.client.grants.add({ name: 'dev', secret: 'claude' });
  await ctx.client.secrets.delete({ name: 'claude' });

  const grants = await ctx.client.grants.list({ name: 'dev' });
  const files = await readdir(join(ctx.dataDir, 'secrets'));

  expect(grants).toStrictEqual(['gh']);
  expect(files).toStrictEqual([expect.toStartWith('gh.')]);
});

test('it takes the grants of a destroyed imp along', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });
  await ctx.client.imps.destroy({ name: 'dev' });

  const left = await ctx.db.selectFrom('grants').selectAll().execute();

  expect(left).toStrictEqual([]);
});

test('it gives an imp without a grant no broker variables and installs nothing', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });

  const imp = await readImpByName(ctx.db, 'dev');

  invariant(imp);

  const vsock = join(ctx.dataDir, 'vsock');

  await writeFile(vsock, '');

  const env = await ctx.impd.broker.readExecEnv(imp, vsock);

  expect(env).toStrictEqual({ kind: 'ungranted' });
  expect(ctx.installs).toStrictEqual([]);
});

test('it gives a granted imp the broker variables once the CA is in its boot', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  const imp = await readImpByName(ctx.db, 'dev');

  invariant(imp);

  const vsock = join(ctx.dataDir, 'vsock');

  await writeFile(vsock, '');

  const env = await ctx.impd.broker.readExecEnv(imp, vsock);

  expect(env).toStrictEqual({
    kind: 'ready',
    env: [
      `HTTPS_PROXY=http://127.0.0.1:${String(ctx.config.brokerPort)}`,
      `https_proxy=http://127.0.0.1:${String(ctx.config.brokerPort)}`,
      'NO_PROXY=localhost,127.0.0.1,::1',
      'no_proxy=localhost,127.0.0.1,::1',
      'NODE_USE_ENV_PROXY=1',
      'SSL_CERT_FILE=/etc/imp/broker-ca.pem',
      'NODE_EXTRA_CA_CERTS=/etc/imp/broker-ca.pem',
      'GIT_SSL_CAINFO=/etc/imp/broker-ca.pem',
      'REQUESTS_CA_BUNDLE=/etc/imp/broker-ca.pem',
      'CURL_CA_BUNDLE=/etc/imp/broker-ca.pem',
      'GH_TOKEN=imp-broker-placeholder',
      'GITHUB_TOKEN=imp-broker-placeholder',
    ],
  });
});

test.each([
  [
    { preset: 'github' },
    ['GH_TOKEN=imp-broker-placeholder', 'GITHUB_TOKEN=imp-broker-placeholder'],
  ],
  [{ preset: 'anthropic' }, ['ANTHROPIC_API_KEY=imp-broker-placeholder']],
  [{ preset: 'npm' }, ['NPM_TOKEN=imp-broker-placeholder']],
  [{ kind: 'anthropic' }, ['ANTHROPIC_API_KEY=imp-broker-placeholder']],
  [{ kind: 'npm' }, ['NPM_TOKEN=imp-broker-placeholder']],
] as const)(
  'it gives an imp granted %o its preset’s placeholders',
  async (binding, placeholders) => {
    const ctx = await setupTest();

    await ctx.createTestImage('base');
    await ctx.client.imps.create({ name: 'dev' });
    await ctx.client.secrets.add({ name: 'cred', value: 'fake-value-1', ...binding });
    await ctx.client.grants.add({ name: 'dev', secret: 'cred' });

    const imp = await readImpByName(ctx.db, 'dev');

    invariant(imp);

    const vsock = join(ctx.dataDir, 'vsock');

    await writeFile(vsock, '');

    const env = await ctx.impd.broker.readExecEnv(imp, vsock);

    expect(env).toStrictEqual({
      kind: 'ready',
      env: [
        `HTTPS_PROXY=http://127.0.0.1:${String(ctx.config.brokerPort)}`,
        `https_proxy=http://127.0.0.1:${String(ctx.config.brokerPort)}`,
        'NO_PROXY=localhost,127.0.0.1,::1',
        'no_proxy=localhost,127.0.0.1,::1',
        'NODE_USE_ENV_PROXY=1',
        'SSL_CERT_FILE=/etc/imp/broker-ca.pem',
        'NODE_EXTRA_CA_CERTS=/etc/imp/broker-ca.pem',
        'GIT_SSL_CAINFO=/etc/imp/broker-ca.pem',
        'REQUESTS_CA_BUNDLE=/etc/imp/broker-ca.pem',
        'CURL_CA_BUNDLE=/etc/imp/broker-ca.pem',
        ...placeholders,
      ],
    });
  },
);

test('it gives an imp granted a static secret the variables the secret names', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.secrets.add({
    name: 'api',
    kind: 'static',
    value: 'fake-value-1',
    rules: [{ host: 'api.example.com', header: 'x-token', scheme: 'raw' }],
    env: ['EXAMPLE_TOKEN'],
  });

  await ctx.client.grants.add({ name: 'dev', secret: 'api' });

  const imp = await readImpByName(ctx.db, 'dev');

  invariant(imp);

  const vsock = join(ctx.dataDir, 'vsock');

  await writeFile(vsock, '');

  const env = await ctx.impd.broker.readExecEnv(imp, vsock);

  expect(env).toMatchObject({
    kind: 'ready',
    env: expect.arrayContaining(['EXAMPLE_TOKEN=imp-broker-placeholder']) as unknown,
  });
});

test('it sets the placeholders of a granted secret’s stored env list, not its preset’s', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });
  await ctx.db
    .updateTable('secrets')
    .set({ env: JSON.stringify(['CUSTOM_TOKEN']) })
    .where('name', '=', 'gh')
    .execute();

  const imp = await readImpByName(ctx.db, 'dev');

  invariant(imp);

  const vsock = join(ctx.dataDir, 'vsock');

  await writeFile(vsock, '');

  const env = await ctx.impd.broker.readExecEnv(imp, vsock);

  expect(env).toStrictEqual({
    kind: 'ready',
    env: [
      `HTTPS_PROXY=http://127.0.0.1:${String(ctx.config.brokerPort)}`,
      `https_proxy=http://127.0.0.1:${String(ctx.config.brokerPort)}`,
      'NO_PROXY=localhost,127.0.0.1,::1',
      'no_proxy=localhost,127.0.0.1,::1',
      'NODE_USE_ENV_PROXY=1',
      'SSL_CERT_FILE=/etc/imp/broker-ca.pem',
      'NODE_EXTRA_CA_CERTS=/etc/imp/broker-ca.pem',
      'GIT_SSL_CAINFO=/etc/imp/broker-ca.pem',
      'REQUESTS_CA_BUNDLE=/etc/imp/broker-ca.pem',
      'CURL_CA_BUNDLE=/etc/imp/broker-ca.pem',
      'CUSTOM_TOKEN=imp-broker-placeholder',
    ],
  });
});

test('it points an imp in another slot at that slot’s gateway', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.create({ name: 'dev-2' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });
  await ctx.client.grants.add({ name: 'dev-2', secret: 'gh' });

  const imp = await readImpByName(ctx.db, 'dev-2');

  invariant(imp);

  const vsock = join(ctx.dataDir, 'vsock');

  await writeFile(vsock, '');

  const env = await ctx.impd.broker.readExecEnv(imp, vsock);

  expect(env).toStrictEqual({
    kind: 'ready',
    env: [
      `HTTPS_PROXY=http://127.0.0.5:${String(ctx.config.brokerPort)}`,
      `https_proxy=http://127.0.0.5:${String(ctx.config.brokerPort)}`,
      'NO_PROXY=localhost,127.0.0.1,::1',
      'no_proxy=localhost,127.0.0.1,::1',
      'NODE_USE_ENV_PROXY=1',
      'SSL_CERT_FILE=/etc/imp/broker-ca.pem',
      'NODE_EXTRA_CA_CERTS=/etc/imp/broker-ca.pem',
      'GIT_SSL_CAINFO=/etc/imp/broker-ca.pem',
      'REQUESTS_CA_BUNDLE=/etc/imp/broker-ca.pem',
      'CURL_CA_BUNDLE=/etc/imp/broker-ca.pem',
      'GH_TOKEN=imp-broker-placeholder',
      'GITHUB_TOKEN=imp-broker-placeholder',
    ],
  });
});

test('it installs the CA once per boot however many execs ask', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  const imp = await readImpByName(ctx.db, 'dev');

  invariant(imp);

  const vsock = join(ctx.dataDir, 'vsock');

  await writeFile(vsock, '');

  await ctx.impd.broker.readExecEnv(imp, vsock);
  await ctx.impd.broker.readExecEnv(imp, vsock);

  expect(ctx.installs).toStrictEqual([vsock]);
});

test('it gives a new boot whose install fails no broker variables, and logs why', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  const imp = await readImpByName(ctx.db, 'dev');

  invariant(typeof imp?.pid === 'number');

  const vsock = join(ctx.dataDir, 'vsock');

  await writeFile(vsock, '');

  await ctx.impd.broker.readExecEnv(imp, vsock);

  const env = await ctx.impd.broker.readExecEnv(
    { ...imp, pid: imp.pid + 1 },
    join(ctx.dataDir, 'gone'),
  );

  expect(env).toStrictEqual({ kind: 'untrusted', detail: expect.toStartWith('ENOENT') });

  expect(ctx.logs).toContainEqual(
    expect.toStartWith(
      'WARNING impd.imps imp=dev broker CA not installed, so this exec gets no broker variables: ENOENT',
    ),
  );
});

test('it installs again for the same pid after the imp stops', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  const imp = await readImpByName(ctx.db, 'dev');

  invariant(imp);

  const vsock = join(ctx.dataDir, 'vsock');

  await writeFile(vsock, '');

  await ctx.impd.broker.readExecEnv(imp, vsock);
  await ctx.client.imps.stop({ name: 'dev' });
  await ctx.impd.broker.readExecEnv(imp, vsock);

  expect(ctx.installs).toStrictEqual([vsock, vsock]);
});

test('it keeps the newest audit rows of each imp', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const dev = await ctx.client.imps.create({ name: 'dev' });

  for (let index = 0; index < AUDIT_ROWS_PER_IMP + 5; index += 1) {
    await writeAuditEntry(
      ctx.db,
      buildMockNewAuditEntry({ impId: dev.id, path: `/${String(index)}` }),
    );
  }

  const rows = await listAuditEntries(ctx.db, dev.id, 2000, null);

  expect(rows).toHaveLength(AUDIT_ROWS_PER_IMP);
  expect(rows[0]?.path).toBe(`/${String(AUDIT_ROWS_PER_IMP + 4)}`);
});

test('it keeps the sent rows of an imp whose refused rows pass the cap', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const dev = await ctx.client.imps.create({ name: 'dev' });

  await writeAuditEntry(ctx.db, buildMockNewAuditEntry({ impId: dev.id, path: '/sent' }));

  for (let index = 0; index < AUDIT_ROWS_PER_IMP + 1; index += 1) {
    await writeAuditEntry(
      ctx.db,
      buildMockNewAuditEntry({
        impId: dev.id,
        secretName: null,
        method: 'CONNECT',
        path: null,
        status: 403,
        reason: 'egress-policy',
      }),
    );
  }

  const rows = await listAuditEntries(ctx.db, dev.id, 2000, null);

  expect(rows.map((row) => row.path)).toStrictEqual(['/sent']);
});

test('it keeps the newest refused rows of each imp', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const dev = await ctx.client.imps.create({ name: 'dev' });

  for (let index = 0; index < AUDIT_ROWS_PER_IMP + 1; index += 1) {
    await writeAuditEntry(
      ctx.db,
      buildMockNewAuditEntry({
        impId: dev.id,
        secretName: null,
        method: 'CONNECT',
        host: `h${String(index)}.test`,
        path: null,
        status: 403,
        reason: 'egress-policy',
      }),
    );
  }

  const rows = await listRefusedRequests(ctx.db, dev.id, 2000, null);

  expect(rows).toHaveLength(AUDIT_ROWS_PER_IMP);
  expect(rows[0]?.host).toBe(`h${String(AUDIT_ROWS_PER_IMP)}.test`);
});

test('it lists only the sent requests in the audit, and only the refused ones as refused', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const dev = await ctx.client.imps.create({ name: 'dev' });

  await writeAuditEntry(ctx.db, buildMockNewAuditEntry({ impId: dev.id, path: '/sent' }));

  await writeAuditEntry(
    ctx.db,
    buildMockNewAuditEntry({
      impId: dev.id,
      impName: 'dev',
      secretName: null,
      method: 'CONNECT',
      host: 'exfil.test',
      path: null,
      status: 403,
      durationMs: 2,
      reason: 'egress-policy',
    }),
  );

  const sent = await ctx.client.audit.list({ name: 'dev' });
  const refused: unknown = await ctx.client.audit.refused({ name: 'dev' });

  expect(sent.map((entry) => entry.path)).toStrictEqual(['/sent']);

  expect(refused).toStrictEqual([
    {
      at: expect.toBeValidDate() as unknown,
      imp: 'dev',
      method: 'CONNECT',
      host: 'exfil.test',
      path: null,
      status: 403,
      durationMs: 2,
      reason: 'egress-policy',
    },
  ]);
});

test('it lists the audit rows of an imp newest first, up to the limit', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const dev = await ctx.client.imps.create({ name: 'dev' });

  for (const path of ['/a', '/b', '/c']) {
    await writeAuditEntry(ctx.db, buildMockNewAuditEntry({ impId: dev.id, path }));
  }

  const listed = await ctx.client.audit.list({ name: 'dev', limit: 2 });

  expect(listed.map((row) => row.path)).toStrictEqual(['/c', '/b']);
});

test('it caps an audit listing at 1000 rows whatever the limit asked', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const dev = await ctx.client.imps.create({ name: 'dev' });
  const other = await ctx.client.imps.create({ name: 'other' });

  for (const impId of [dev.id, other.id]) {
    for (let index = 0; index < 550; index += 1) {
      await writeAuditEntry(ctx.db, buildMockNewAuditEntry({ impId }));
    }
  }

  const rows = await ctx.impd.broker.listAudit(null, 5000, null);

  expect(rows).toHaveLength(1000);
});

test('it lists only the audit rows of imps within the patterns', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const dev = await ctx.client.imps.create({ name: 'dev' });
  const other = await ctx.client.imps.create({ name: 'other' });

  await writeAuditEntry(ctx.db, buildMockNewAuditEntry({ impId: dev.id, impName: 'dev' }));
  await writeAuditEntry(ctx.db, buildMockNewAuditEntry({ impId: other.id, impName: 'other' }));

  const rows = await ctx.impd.broker.listAudit(null, 10, ['de*']);

  expect(rows.map((row) => row.imp)).toStrictEqual(['dev']);
});

test('it keeps the audit rows of a destroyed imp under its name', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const dev = await ctx.client.imps.create({ name: 'dev' });

  await writeAuditEntry(
    ctx.db,
    buildMockNewAuditEntry({ impId: dev.id, impName: 'dev', path: '/kept' }),
  );

  await ctx.client.imps.destroy({ name: 'dev' });

  const left = await listAuditEntries(ctx.db, null, 10, null);

  expect(left.map((row) => [row.imp, row.path])).toStrictEqual([['dev', '/kept']]);
});

test('it reports a fork whose grants cannot be copied, and logs the cause', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const dev = await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  const report = await ctx.impd.broker.createForkGrants(dev, { id: 'gone', name: 'gone' }, null);

  expect(report).toStrictEqual({
    notCopied: [],
    error:
      "the source's grants could not be copied, so the fork has none; impd's log has the cause",
  });

  expect(ctx.logs).toContainEqual(
    expect.toStartWith('WARNING impd.imps imp=gone forked without the grants of dev: '),
  );
});

test('it copies no grant to a fork whose token was removed, and says so', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const dev = await ctx.client.imps.create({ name: 'dev' });
  const copy = await ctx.client.imps.create({ name: 'copy' });

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  const secret = await readSecret(ctx.db, 'gh');

  invariant(secret);

  const report = await ctx.impd.broker.createForkGrants(dev, copy, {
    tokenId: 'removed-token',
    grantable: [{ name: 'gh', generation: secret.generation }],
  });

  const grants = await ctx.client.grants.list({ name: 'copy' });

  expect(report).toStrictEqual({
    notCopied: [],
    error: "the token behind this fork was removed, so it got none of the source's grants",
  });

  expect(grants).toStrictEqual([]);

  expect(ctx.logs).toContain(
    'INFO impd.imps imp=copy forked without the grants of dev: the token was removed',
  );
});

test('it skips a grant the caller may not make on a fork, and logs why', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const dev = await ctx.client.imps.create({ name: 'dev' });
  const copy = await ctx.client.imps.create({ name: 'copy' });

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  const report = await ctx.impd.broker.createForkGrants(dev, copy, {
    tokenId: null,
    grantable: [],
  });

  expect(report).toStrictEqual({
    notCopied: [{ secret: 'gh', reason: 'not-grantable' }],
    error: null,
  });

  expect(ctx.logs).toContain(
    'INFO impd.imps imp=copy forked without grant gh of dev: the caller may not grant it',
  );
});

test('it skips a grant that clashes on a fork, and logs why', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const dev = await ctx.client.imps.create({ name: 'dev' });
  const copy = await ctx.client.imps.create({ name: 'copy' });

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });

  await ctx.client.secrets.add({
    name: 'gh-api',
    kind: 'custom',
    value: 'ghp_SECRETVALUE0123456789',
    rules: [buildMockBrokerRule({ host: 'api.github.com' })],
  });

  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });
  await ctx.client.grants.add({ name: 'copy', secret: 'gh-api' });

  const report = await ctx.impd.broker.createForkGrants(dev, copy, null);

  expect(report).toStrictEqual({ notCopied: [{ secret: 'gh', reason: 'clash' }], error: null });

  expect(ctx.logs).toContain(
    'INFO impd.imps imp=copy forked without grant gh of dev: it has another credential for that host',
  );
});

test('it keeps the old value and makes no new file when a replace clashes', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });

  await ctx.client.secrets.add({
    name: 'claude',
    kind: 'anthropic',
    value: 'ghp_SECRETVALUE0123456789',
  });

  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });
  await ctx.client.grants.add({ name: 'dev', secret: 'claude' });

  const before = await readSecret(ctx.db, 'claude');

  const clash = ctx.client.secrets.add({
    name: 'claude',
    kind: 'custom',
    value: 'other',
    rules: [buildMockBrokerRule({ host: 'api.github.com' })],
    replace: true,
  });

  expect(clash).rejects.toMatchObject({ code: 'CONFLICT' });

  invariant(before);

  const after = await readSecret(ctx.db, 'claude');
  const value = await readFile(join(ctx.dataDir, 'secrets', before.valueFile), 'utf8');
  const files = await readdir(join(ctx.dataDir, 'secrets'));

  expect(after).toStrictEqual(before);
  expect(value).toBe('ghp_SECRETVALUE0123456789');
  expect(files).toHaveLength(2);
});

test('it logs a grant change it could not apply rather than throw', async () => {
  const ctx = await setupTest();

  await runSql(ctx.db, 'ALTER TABLE grants RENAME TO grants_gone');

  await ctx.impd.broker.applyGrants();

  expect(ctx.logs).toContainEqual(
    expect.toStartWith('WARNING impd.broker could not apply grants: '),
  );
});

test('it logs an audit row it could not write and still answers the request', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  await runSql(
    ctx.db,
    `CREATE TRIGGER fail_audit BEFORE INSERT ON broker_audit
    BEGIN SELECT RAISE(ABORT, 'forced failure'); END`,
  );

  server.use(http.get('https://api.github.com/user', () => HttpResponse.text('from upstream')));

  const port = await ctx.impd.broker.listen(0);
  const ca = await readFile(join(ctx.dataDir, 'broker', 'ca', 'ca.pem'), 'utf8');

  const established = Promise.withResolvers<Socket>();

  const tunnel = createConnection({ host: '127.0.0.1', port, localAddress: '127.0.0.2' }, () => {
    tunnel.write('CONNECT api.github.com:443 HTTP/1.1\r\nHost: api.github.com:443\r\n\r\n');
  });

  onTestFinished(() => {
    tunnel.destroy();
  });

  tunnel.once('data', () => {
    established.resolve(tunnel);
  });

  const secure = connectTls({
    socket: await established.promise,
    servername: 'api.github.com',
    ca,
  });

  const chunks: Buffer[] = [];
  const ended = Promise.withResolvers<void>();

  secure.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });

  secure.once('end', ended.resolve);
  secure.write('GET /user HTTP/1.1\r\nHost: api.github.com\r\nConnection: close\r\n\r\n');

  await ended.promise;

  const logged = await waitFor(() => {
    const line = ctx.logs.find((each) => each.startsWith('WARNING impd.broker audit write failed'));

    invariant(line !== undefined);

    return line;
  });

  expect(Buffer.concat(chunks).toString()).toMatch(/^HTTP\/1\.1 200 [\s\S]*from upstream$/u);
  expect(logged).toBe('WARNING impd.broker audit write failed: forced failure');
});

test('it refuses a tunnel into the imps’ IPv6 prefix', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });

  const prefix = parsePrefix64('fd12:3456:789a:1::/64');

  invariant(prefix);

  const broker = await createBroker({
    config: ctx.config,
    db: ctx.db,
    timer: ctx.tickers.timer,
    resolveUpstream: resolvePublicUpstream,
    reach: createReachPolicy({
      subnet: ctx.config.subnet,
      deny: [],
      ipv6: { prefix, nat66: false, uplink: null },
      now: Date.now,
      ...buildStubHostRoutes().deps,
    }),
  });

  ctx.stack.defer(() => broker.stop());

  const port = await broker.listen(0);
  const guest = await startStubBrokerGuestSocket(ctx.stack, { port, address: '127.0.0.2' });

  guest.write('CONNECT [fd12:3456:789a:1::9]:443 HTTP/1.1\r\n\r\n');

  const reply = await guest.reply;

  expect(reply).toBe(
    'HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\ncontent-length: 82\r\nconnection: close\r\n\r\n' +
      'fd12:3456:789a:1::9 resolves to fd12:3456:789a:1::9, which a tunnel may not reach\n',
  );
});

test('it dials a public IPv6 address when impd has IPv6', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });

  const prefix = parsePrefix64('fd12:3456:789a:1::/64');

  invariant(prefix);

  const dialled: string[] = [];

  const target = await startStubBrokerReplyTarget(ctx.stack, 'tunnel');

  const broker = await createBroker({
    config: ctx.config,
    db: ctx.db,
    timer: ctx.tickers.timer,
    resolveUpstream: resolvePublicUpstream,
    reach: createReachPolicy({
      subnet: ctx.config.subnet,
      deny: [],
      ipv6: { prefix, nat66: false, uplink: null },
      now: Date.now,
      ...buildStubHostRoutes().deps,
    }),
    dialTunnel: (host) => {
      dialled.push(host);

      return createConnection({ host: '127.0.0.1', port: target.port });
    },
  });

  ctx.stack.defer(() => broker.stop());

  const port = await broker.listen(0);
  const guest = await startStubBrokerGuestSocket(ctx.stack, { port, address: '127.0.0.2' });

  guest.write(
    'CONNECT [2606:4700::1111]:443 HTTP/1.1\r\n\r\nGET / HTTP/1.1\r\nHost: example.com\r\n\r\n',
  );

  const reply = await guest.reply;

  expect(reply).toBe(
    'HTTP/1.1 200 Connection Established\r\n\r\n' +
      'HTTP/1.1 200 OK\r\ncontent-length: 6\r\nconnection: close\r\n\r\ntunnel',
  );

  expect(dialled).toStrictEqual(['2606:4700::1111']);
  expect(target.received).toStrictEqual(['GET / HTTP/1.1\r\nHost: example.com\r\n\r\n']);
});

test('it refuses every IPv6 tunnel when impd has no IPv6', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });

  const broker = await createBroker({
    config: ctx.config,
    db: ctx.db,
    timer: ctx.tickers.timer,
    resolveUpstream: resolvePublicUpstream,
    reach: createReachPolicy({
      subnet: ctx.config.subnet,
      deny: [],
      ipv6: null,
      now: Date.now,
      ...buildStubHostRoutes().deps,
    }),
  });

  ctx.stack.defer(() => broker.stop());

  const port = await broker.listen(0);
  const guest = await startStubBrokerGuestSocket(ctx.stack, { port, address: '127.0.0.2' });

  guest.write('CONNECT [2606:4700::1111]:443 HTTP/1.1\r\n\r\n');

  const reply = await guest.reply;

  expect(reply).toBe(
    'HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\ncontent-length: 74\r\nconnection: close\r\n\r\n' +
      '2606:4700::1111 resolves to 2606:4700::1111, which a tunnel may not reach\n',
  );
});
