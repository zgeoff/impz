import { expect, mock, onTestFinished, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { server } from '@impz/test-utils/mock-server';
import { readImpEnv } from '@impz/test-utils/read-imp-env';
import { updateEnv } from '@impz/test-utils/update-env';
import { waitFor } from '@impz/test-utils/wait-for';
import { HttpResponse, http } from 'msw';
import invariant from 'tiny-invariant';
import { buildStubTailscaleServe } from '../../../testing/network/build-stub-tailscale-serve';
import { createStubTailscaleApi } from '../../../testing/network/create-stub-tailscale-api';
import { captureImpdLogs } from '../../../testing/platform/capture-impd-logs';
import { startTestImpd } from '../../../testing/start-test-impd';
import { deriveSlotAddress } from '../../host-net/net/addressing';
import type { TailscaleStatus } from '../../host-net/net/tailscale-status';
import { readImpByName, updateImpMove } from '../../platform/db/imps';
import { createServiceServe } from './service-serve';
import { createServicesApi } from './services-api';
import { SERVICE_TAG, createTailnetNames } from './tailnet-names';
import type { TailnetNamesDeps } from './tailnet-names';
import { createPresenceCheck } from './wire-tailnet-names';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const tailscale = buildStubTailscaleServe();
  const tailscaleStatus = Promise.withResolvers<TailscaleStatus>();

  const harness = await startTestImpd(stack, {
    env: readImpEnv(),
    boundaries: {
      readTailscale: () => tailscaleStatus.promise,

      runCommand: tailscale.run,
    },
  });

  const tailscaleApi = createStubTailscaleApi({
    client: { clientId: 'kExample', clientSecret: 'secret' },
  });

  server.use(...tailscaleApi.handlers);

  const namesDeps: Omit<TailnetNamesDeps, 'hostId'> = {
    config: { prefix: '', oauthFile: join(harness.dataDir, 'unused-oauth.json') },
    db: harness.db,
    api: createServicesApi({
      readCredential: () => ({ clientId: 'kExample', clientSecret: 'secret' }),
    }),
    serve: createServiceServe(tailscale.runChecked),
    findPort: (slot) => deriveSlotAddress(slot, harness.config).tailnetPort,
    isImpPresent: createPresenceCheck(harness.imps, harness.db),

    readSuffix: () => Promise.resolve(null),
  };

  // assigned, not spread: a spread reads the harness's parts once
  return Object.assign(harness, {
    tailscaleApi,
    tailscale,
    tailscaleStatus,
    logs: captureImpdLogs(),
    namesDeps,
  });
}

test('it claims a service of this host’s for each imp', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'box' });

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();

  const stored: unknown[] = ctx.tailscaleApi.services.all();

  expect(stored).toStrictEqual([
    {
      name: 'svc:box',
      comment: 'imp host host-a',
      ports: ['tcp:80', 'tcp:443'],
      tags: [SERVICE_TAG],
    },
  ]);
});

test('it reads the service again before it writes it', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'box' });

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();

  expect(
    ctx.tailscaleApi.requests.map((request) => `${request.method} ${request.path}`),
  ).toStrictEqual([
    'POST /oauth/token',
    'GET /tailnet/-/services',
    'GET /tailnet/-/services/svc%3Abox',
    'PUT /tailnet/-/services/svc%3Abox',
  ]);
});

test('it serves each imp’s service to the imp’s own port', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'box' });

  const imp = await readImpByName(ctx.db, 'box');

  invariant(imp);

  const target = `http://127.0.0.1:${String(deriveSlotAddress(imp.slot, ctx.config).tailnetPort)}`;
  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();

  expect(ctx.tailscale.calls).toStrictEqual([
    ['tailscale', 'serve', 'status', '--json'],
    ['tailscale', 'serve', '--service=svc:box', '--http=80', target],
    ['tailscale', 'serve', '--service=svc:box', '--https=443', target],
  ]);
});

test('it writes the service before it serves it', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'box' });

  const servedAtWrite = mock<(calls: readonly (readonly string[])[]) => void>();

  server.use(
    http.put('https://api.tailscale.com/api/v2/tailnet/-/services/:name', () => {
      servedAtWrite([...ctx.tailscale.calls]);
    }),
  );

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();

  expect(servedAtWrite).toHaveBeenCalledExactlyOnceWith([
    ['tailscale', 'serve', 'status', '--json'],
  ]);
});

test('it gives a live name its https URL on the tailnet', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'box' });

  const names = createTailnetNames({
    ...ctx.namesDeps,
    hostId: 'host-a',
    readSuffix: () => Promise.resolve('tail1234.ts.net'),
  });

  await names.runSync();

  expect(names.readUrl('box')).toBe('https://box.tail1234.ts.net');
});

test('it gives no URL while the tailnet suffix is unknown', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'box' });

  const names = createTailnetNames({
    ...ctx.namesDeps,
    hostId: 'host-a',
    readSuffix: () => Promise.resolve(null),
  });

  await names.runSync();

  expect(names.readUrl('box')).toBeNull();
});

test('it counts each live name in its status', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'box' });

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();

  expect(names.readStatus()).toStrictEqual({ live: 1, failed: [] });
});

test('it logs a name once when it goes live', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'box' });

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();
  await names.runSync();

  expect(ctx.logs.filter((line) => line.includes(' impd.tailnet '))).toStrictEqual([
    'INFO impd.tailnet imp=box tailnet names: named svc:box',
  ]);
});

test('it only lists the services on a pass that finds everything in place', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'box' });

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();

  const before = ctx.tailscaleApi.requests.length;
  const servedBefore = ctx.tailscale.calls.length;

  await names.runSync();

  expect(
    ctx.tailscaleApi.requests.slice(before).map((request) => `${request.method} ${request.path}`),
  ).toStrictEqual(['GET /tailnet/-/services']);

  expect(ctx.tailscale.calls.slice(servedBefore)).toStrictEqual([
    ['tailscale', 'serve', 'status', '--json'],
  ]);
});

test('it never writes over a service by that name that another owner holds', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.tailscaleApi.services.create({ name: 'svc:box', comment: 'the web team', tags: [] });
  await ctx.client.imps.create({ name: 'box' });

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();

  expect(ctx.tailscaleApi.requests.map((request) => request.method)).not.toContain('PUT');

  expect(
    ctx.tailscaleApi.services.findFirst((query) => query.where({ name: 'svc:box' })),
  ).toMatchObject({
    comment: 'the web team',
  });
});

test('it fails a name another owner holds, and gives it no URL', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.tailscaleApi.services.create({ name: 'svc:box', comment: 'the web team', tags: [] });

  await ctx.tailscaleApi.services.create({
    name: 'svc:web',
    comment: 'imp host host-b',
    tags: [SERVICE_TAG],
  });

  await ctx.client.imps.create({ name: 'box' });
  await ctx.client.imps.create({ name: 'web' });

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();

  expect(names.readUrl('box')).toBeNull();

  expect(names.readStatus()).toStrictEqual({
    live: 0,
    failed: [
      { name: 'box', error: 'svc:box exists and this host does not own it' },
      { name: 'web', error: 'svc:web exists and this host does not own it' },
    ],
  });
});

test('it fails a name whose service appears after the list, and never writes it', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.tailscaleApi.services.create({ name: 'svc:box', comment: 'someone else', tags: [] });
  await ctx.client.imps.create({ name: 'box' });

  server.use(
    http.get(
      'https://api.tailscale.com/api/v2/tailnet/-/services',
      () => HttpResponse.json({ vipServices: [] }),
      { once: true },
    ),
  );

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();

  expect(names.readStatus().failed).toStrictEqual([
    { name: 'box', error: 'svc:box exists and this host does not own it' },
  ]);

  expect(ctx.tailscaleApi.requests.map((request) => request.method)).not.toContain('PUT');
});

test('it clears a destroyed imp’s serve config, then deletes its service', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'box' });

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();
  await ctx.client.imps.destroy({ name: 'box' });

  const lastServeAtDelete = mock<(argv: readonly string[] | undefined) => void>();

  server.use(
    http.delete('https://api.tailscale.com/api/v2/tailnet/-/services/:name', () => {
      lastServeAtDelete(ctx.tailscale.calls.at(-1));
    }),
  );

  await names.runSync();

  expect(lastServeAtDelete).toHaveBeenCalledExactlyOnceWith([
    'tailscale',
    'serve',
    'clear',
    'svc:box',
  ]);

  expect(ctx.tailscaleApi.services.count()).toBe(0);
});

test('it counts no live name once its imp is destroyed', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'box' });

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();
  await ctx.client.imps.destroy({ name: 'box' });
  await names.runSync();

  expect(names.readStatus()).toStrictEqual({ live: 0, failed: [] });
});

test('it logs the removal of a service no imp has', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'box' });

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();
  await ctx.client.imps.destroy({ name: 'box' });
  await names.runSync();

  expect(ctx.logs.at(-1)).toBe(
    'INFO impd.tailnet tailnet names: removed svc:box, which no imp has',
  );
});

test('it never removes another host’s, another owner’s or an untagged service', async () => {
  const ctx = await setupTest();

  await ctx.tailscaleApi.services.create({
    name: 'svc:other',
    comment: 'imp host host-b',
    tags: [SERVICE_TAG],
  });

  await ctx.tailscaleApi.services.create({ name: 'svc:team', comment: 'the web team', tags: [] });

  await ctx.tailscaleApi.services.create({
    name: 'svc:untagged',
    comment: 'imp host host-a',
    tags: [],
  });

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();

  expect(ctx.tailscaleApi.services.all().map((service) => service.name)).toIncludeSameMembers([
    'svc:other',
    'svc:team',
    'svc:untagged',
  ]);
});

test('it keeps a moving imp’s service while the move sends', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'box' });

  const imp = await readImpByName(ctx.db, 'box');

  invariant(imp);

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();

  await updateImpMove(ctx.db, imp.id, 'sending');

  await names.runSync();

  expect(ctx.tailscaleApi.services.count()).toBe(1);
});

test('it neither writes nor clears a moving imp’s service while the move sends', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'box' });

  const imp = await readImpByName(ctx.db, 'box');

  invariant(imp);

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();

  await updateImpMove(ctx.db, imp.id, 'sending');

  const requestsBefore = ctx.tailscaleApi.requests.length;
  const servedBefore = ctx.tailscale.calls.length;

  await names.runSync();

  expect(
    ctx.tailscaleApi.requests
      .slice(requestsBefore)
      .map((request) => `${request.method} ${request.path}`),
  ).toStrictEqual(['GET /tailnet/-/services']);

  expect(ctx.tailscale.calls.slice(servedBefore)).toStrictEqual([
    ['tailscale', 'serve', 'status', '--json'],
  ]);
});

test('it removes a moved imp’s service once the target holds a verified copy', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'box' });

  const imp = await readImpByName(ctx.db, 'box');

  invariant(imp);

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();

  await updateImpMove(ctx.db, imp.id, 'sending');
  await updateImpMove(ctx.db, imp.id, 'moved');

  await names.runSync();

  expect(ctx.tailscaleApi.services.count()).toBe(0);
});

test('it never removes a service another host claimed for an imp it no longer has', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'box' });

  const first = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await first.runSync();
  await ctx.client.imps.destroy({ name: 'box' });

  const second = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-b' });

  await second.runSync();

  expect(ctx.tailscaleApi.services.all().map((service) => service.name)).toStrictEqual(['svc:box']);
});

test('it fails every name with the error while the API is down', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'box' });

  server.use(
    http.get('https://api.tailscale.com/api/v2/tailnet/-/services', () =>
      HttpResponse.json({ message: 'unavailable' }, { status: 503 }),
    ),
  );

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();

  expect(names.readStatus()).toStrictEqual({
    live: 0,
    failed: [{ name: 'box', error: 'Tailscale GET /tailnet/-/services: 503 unavailable' }],
  });
});

test('it logs a failure once while it stays the same', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'box' });

  server.use(
    http.get('https://api.tailscale.com/api/v2/tailnet/-/services', () =>
      HttpResponse.json({ message: 'unavailable' }, { status: 503 }),
    ),
  );

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();
  await names.runSync();

  expect(ctx.logs.filter((line) => line.includes(' impd.tailnet '))).toStrictEqual([
    'WARNING impd.tailnet imp=box tailnet names: Tailscale GET /tailnet/-/services: 503 unavailable',
  ]);
});

test('it brings a name back on the pass after an outage ends', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'box' });

  server.use(
    http.get(
      'https://api.tailscale.com/api/v2/tailnet/-/services',
      () => HttpResponse.json({ message: 'unavailable' }, { status: 503 }),
      { once: true },
    ),
  );

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();

  const duringOutage = names.readStatus();

  await names.runSync();

  expect(duringOutage.live).toBe(0);
  expect(names.readStatus()).toStrictEqual({ live: 1, failed: [] });
});

test('it fails only the imp whose name a device holds, and keeps that imp running', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  server.use(
    http.put('https://api.tailscale.com/api/v2/tailnet/-/services/svc%3Alaptop', () =>
      HttpResponse.json({ message: 'name in use by a machine' }, { status: 400 }),
    ),
  );

  await ctx.client.imps.create({ name: 'laptop' });
  await ctx.client.imps.create({ name: 'box' });

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();

  const laptop = await readImpByName(ctx.db, 'laptop');

  expect(names.readStatus()).toStrictEqual({
    live: 1,
    failed: [
      {
        name: 'laptop',
        error: 'Tailscale PUT /tailnet/-/services/svc%3Alaptop: 400 name in use by a machine',
      },
    ],
  });

  expect(laptop?.state).toBe('running');
});

test('it clears serve config for a service gone from the tailnet', async () => {
  const ctx = await setupTest();

  await ctx.tailscale.runChecked([
    'tailscale',
    'serve',
    '--service=svc:gone',
    '--http=80',
    'http://127.0.0.1:20005',
  ]);

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();

  expect(ctx.tailscale.calls.at(-1)).toStrictEqual(['tailscale', 'serve', 'clear', 'svc:gone']);
});

test('it logs a removal that fails, and goes on with the pass', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'box' });

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();
  await ctx.client.imps.destroy({ name: 'box' });

  server.use(
    http.delete('https://api.tailscale.com/api/v2/tailnet/-/services/:name', () =>
      HttpResponse.json({ message: 'forbidden' }, { status: 403 }),
    ),
  );

  await names.runSync();

  expect(ctx.logs.at(-1)).toBe(
    'WARNING impd.tailnet tailnet names: removing svc:box: Tailscale DELETE /tailnet/-/services/svc%3Abox: 403 forbidden',
  );
});

test('it shows an imp’s service URL once its name is live', async () => {
  updateEnv('IMP_TAILNET_NAMES', '1');
  updateEnv('IMP_TAILSCALE_NODE', '1');

  const ctx = await setupTest();

  await ctx.createTestImage('base');

  ctx.tailscaleStatus.resolve({
    state: 'Running',
    hostname: 'imp-host',
    dnsName: 'imp-host.tail1234.ts.net',
    ip: null,
    ips: [],
  });

  const oauthFile = ctx.config.tailnetNames?.oauthFile;

  invariant(oauthFile !== undefined);

  await mkdir(dirname(oauthFile), { recursive: true });

  await writeFile(oauthFile, JSON.stringify({ clientId: 'kExample', clientSecret: 'secret' }), {
    mode: 0o600,
  });

  await ctx.client.imps.create({ name: 'box' });

  const service = await waitFor(async () => {
    const urls = await ctx.client.imps.url({ name: 'box' });

    invariant(urls.service !== null);

    return urls.service;
  });

  expect(service).toBe('https://box.tail1234.ts.net');
});

test('it shows no service URL before the name is live', async () => {
  updateEnv('IMP_TAILNET_NAMES', '1');
  updateEnv('IMP_TAILSCALE_NODE', '1');

  const ctx = await setupTest();

  ctx.tailscaleStatus.resolve({
    state: 'Running',
    hostname: 'imp-host',
    dnsName: 'imp-host.tail1234.ts.net',
    ip: null,
    ips: [],
  });

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'box' });

  const failure = await waitFor(() => {
    const line = ctx.logs.find((each) =>
      each.startsWith('WARNING impd.tailnet imp=box tailnet names: '),
    );

    invariant(line !== undefined);

    return line;
  });

  const urls = await ctx.client.imps.url({ name: 'box' });

  expect(failure).toStartWith('WARNING impd.tailnet imp=box tailnet names: ENOENT');
  expect(urls.service).toBeNull();
});
