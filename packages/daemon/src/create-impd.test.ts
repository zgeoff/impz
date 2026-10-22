import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IMAGE_BUILD_STREAM_TYPE } from '@impz/api';
import { buildStubRepeat } from '@impz/mcp/test-utils/build-stub-repeat';
import { readImpEnv } from '@impz/test-utils/read-imp-env';
import { updateEnv } from '@impz/test-utils/update-env';
import { waitFor } from '@impz/test-utils/wait-for';
import invariant from 'tiny-invariant';
import { buildMockNewImage } from '../testing/imps/build-mock-new-image';
import { buildMockNewImp } from '../testing/imps/build-mock-new-imp';
import { createStubDockerCli } from '../testing/imps/create-stub-docker-cli';
import { readNoTailscale } from '../testing/network/read-no-tailscale';
import { buildQueryGate } from '../testing/platform/build-query-gate';
import { buildStubTickerTimer } from '../testing/platform/build-stub-ticker-timer';
import { claimFreePorts } from '../testing/platform/claim-free-ports';
import { startTestImpd } from '../testing/start-test-impd';
import { TEST_TOKEN } from '../testing/test-token';
import { buildStubCpuCgroups } from '../testing/vm/build-stub-cpu-cgroups';
import { buildStubVmm } from '../testing/vm/build-stub-vmm';
import { loadConfig } from './config';
import { createImpd } from './create-impd';
import type { ImpdBoundaries } from './impd-deps';
import { HOST_ADD_WARNING } from './imps/images/create-image-adds';
import { HOST_BUILD_WARNING } from './imps/images/create-image-builds';
import { createImage } from './platform/db/images';
import { createImp, listImps } from './platform/db/imps';
import { openDatabase } from './platform/db/open-database';
import type { ImpDatabase } from './platform/db/open-database';
import { buildSystemDrivePath, buildSystemDrivesDir } from './vm/storage/data-layout';
import { createXfsBackend } from './vm/storage/xfs-backend';
import type { CpuCgroups } from './vm/vmm/cpu-cgroups';

interface SetupOptions {
  readonly cgroups?: CpuCgroups;
  readonly boundaries?: Pick<
    ImpdBoundaries,
    'keepaliveMs' | 'keepaliveRepeat' | 'readProcStatus' | 'images'
  >;
  readonly wrapDatabase?: (db: ImpDatabase) => ImpDatabase;
}

function setupTest(options: SetupOptions = {}) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  return startTestImpd(stack, {
    env: readImpEnv(),
    frozenClockMs: Date.UTC(2026, 0, 1),
    ...options,
  });
}

test('it creates a running imp through the API it serves', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'ubuntu', digest: 'sha256:ubuntu', sizeBytes: 6 }),
  );

  const created = await ctx.client.imps.create({ name: 'dev' });

  expect(created).toMatchObject({ name: 'dev', state: 'running' });
});

test('it adopts a running VM through the new runner when it boots again', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'ubuntu', digest: 'sha256:ubuntu', sizeBytes: 6 }),
  );

  await ctx.client.imps.create({ name: 'dev' });

  const [before] = await listImps(ctx.db);

  invariant(typeof before?.pid === 'number');

  await ctx.restartImpd();

  const slept = await ctx.imps.sleepImp('dev');

  expect(slept.state).toBe('sleeping');
  expect(ctx.fake.boots).toHaveLength(1);
  expect(ctx.fake.stops).toStrictEqual([]);
  expect(ctx.fake.alive.has(before.pid)).toBeFalse();
});

test('it says CPU limits are kept on a host without a cpu controller', async () => {
  const ctx = await setupTest({ cgroups: buildStubCpuCgroups({ isEnforced: false }).cgroups });

  expect(ctx.logs).toContain(
    'impd: no cpu controller under /sys/fs/cgroup/imps; CPU limits are kept, not applied',
  );
});

test('it says no jailed VM can start on a jailed host without a cpu controller', async () => {
  updateEnv('IMP_JAILER', 'true');

  const ctx = await setupTest({ cgroups: buildStubCpuCgroups({ isEnforced: false }).cgroups });

  expect(ctx.logs).toContain(
    'impd: no cpu controller under /sys/fs/cgroup/imps; no jailed VM can start (IMP_JAILER=false runs them unjailed, with no limits)',
  );
});

test('it warns at start that an image with a file capability fails without CAP_SETFCAP', async () => {
  const ctx = await setupTest({
    boundaries: { readProcStatus: () => 'CapEff:\t00000000082810fb\n' },
  });

  expect(ctx.logs).toContain(
    'impd: warning: no CAP_SETFCAP, so an image add or build fails on an image with a file capability; imp-host needs CAP_SETFCAP (docs/architecture/host.md#privileges)',
  );
});

test('it leaves no process exit listener behind once it stops', async () => {
  const exitListeners = process.listenerCount('beforeExit');

  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  await startTestImpd(stack);

  await stack.disposeAsync();

  expect(process.listenerCount('beforeExit')).toBe(exitListeners);
});

test('it writes a failed default image seed to the log it is given', async () => {
  const dockerDir = await mkdtemp(join(tmpdir(), 'create-impd-docker-'));

  onTestFinished(() => rm(dockerDir, { recursive: true, force: true }));

  const docker = createStubDockerCli({
    directory: dockerDir,
    images: [
      {
        refs: ['seed.test/ubuntu:24.04'],
        inspects: [{ Id: `sha256:${'c'.repeat(64)}` }],
        isOnHost: false,
        pull: { stderr: 'pull access denied for seed.test/ubuntu' },
      },
    ],
  });

  updateEnv('PATH', docker.path);
  updateEnv('IMP_BUILD_ISOLATION', 'host');

  const ctx = await setupTest({ boundaries: { images: { seedRef: 'seed.test/ubuntu:24.04' } } });

  await ctx.impd.ready;

  expect(ctx.logs).toContainEqual(expect.toStartWith('impd: could not add the default image: '));
});

test('it closes the ports it opened when a later startup step fails', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  // below the imps' port range, where the config refuses impd's own ports
  const free = claimFreePorts(3, { pick: () => 10_000 + Math.floor(Math.random() * 10_000) });
  const apiPort = free.take();
  const dnsPort = free.take();
  const taken = Bun.listen({ hostname: '0.0.0.0', port: free.take(), socket: { data: () => {} } });

  onTestFinished(() => {
    taken.stop(true);
  });

  expect(
    startTestImpd(stack, {
      env: {
        IMP_API_PORT: String(apiPort),
        IMP_EGRESS_DNS_PORT: String(dnsPort),
        IMP_BROKER_PORT: String(taken.port),
      },
    }),
  ).rejects.toThrow();

  const api = Bun.listen({ hostname: '0.0.0.0', port: apiPort, socket: { data: () => {} } });

  onTestFinished(() => {
    api.stop(true);
  });

  const dns = await Bun.udpSocket({ hostname: '0.0.0.0', port: dnsPort });

  onTestFinished(() => {
    dns.close();
  });

  expect(api.port).toBe(apiPort);
  expect(dns.port).toBe(dnsPort);
});

test('it opens no proxy port for an imp written to its database after it stops', async () => {
  const ctx = await setupTest();

  const image = await createImage(
    ctx.db,
    buildMockNewImage({ name: 'ubuntu', digest: 'sha256:ubuntu', sizeBytes: 6 }),
  );

  const stopped = ctx.impd;

  await ctx.restartImpd();

  const imp = await createImp(ctx.db, buildMockNewImp({ name: 'late', imageId: image.id }));

  await waitFor(() => {
    expect(ctx.impd.proxy.readImpPort(imp.id)).not.toBeNull();
  });

  expect(stopped.proxy.readImpPort(imp.id)).toBeNull();
});

test('it waits for the grant sync an imp write started before it stops', async () => {
  const grantReads = buildQueryGate('grants');

  const ctx = await setupTest({ wrapDatabase: grantReads.wrap });

  const image = await createImage(
    ctx.db,
    buildMockNewImage({ name: 'ubuntu', digest: 'sha256:ubuntu', sizeBytes: 6 }),
  );

  grantReads.arm();

  await createImp(ctx.db, buildMockNewImp({ name: 'late', imageId: image.id }));
  await grantReads.reached;

  const steps = await ctx.impd.stop({ sleepImps: false, stepMaxMs: 50 });

  expect(steps[0]).toStrictEqual({ step: 'db-writes', outcome: 'timed-out' });
});

test('it removes a system drive that no imp uses when it boots', async () => {
  const ctx = await setupTest();

  const stale = buildSystemDrivePath(ctx.dataDir, 'e2'.repeat(32));

  await writeFile(stale, 'stale');

  await ctx.restartImpd();

  expect(Bun.file(stale).exists()).resolves.toBeFalse();
});

test('it removes a builder that a stopped impd left when it boots', async () => {
  const ctx = await setupTest();

  const image = await createImage(
    ctx.db,
    buildMockNewImage({ name: 'ubuntu', digest: 'sha256:ubuntu', sizeBytes: 6 }),
  );

  await createImp(
    ctx.db,
    buildMockNewImp({ name: 'imp-build-left', imageId: image.id, kind: 'builder' }),
  );

  await ctx.restartImpd();

  expect(ctx.logs).toContain('impd: removing builder imp-build-left, which a stopped impd left');
  expect(listImps(ctx.db)).resolves.toStrictEqual([]);
});

test('it drops a move ticket whose stream never came when it boots', async () => {
  const ctx = await setupTest();

  await ctx.db
    .insertInto('move_tickets')
    .values({
      id: 'ticket',
      secret_sha256: 'sha',
      name: 'moved',
      bytes: 1,
      imp_id: null,
      issued_at: 0,
      stream_by: 0,
      stream_used_at: null,
      receipt: null,
      commit_until: null,
      committed_at: null,
      slot: 0,
    })
    .execute();

  await ctx.restartImpd();

  const tickets = await ctx.db.selectFrom('move_tickets').select('id').execute();

  expect(tickets).toStrictEqual([]);
});

test('it ends a lease once its clock passes the lease end', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'ubuntu', digest: 'sha256:ubuntu', sizeBytes: 6 }),
  );

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 30 });

  const held = await ctx.client.leases.list({});

  ctx.advance(30_001);

  const left = await ctx.client.leases.list({});

  expect(held.map((lease) => lease.owner.label)).toStrictEqual(['job']);
  expect(left).toStrictEqual([]);
});

// The test harness always passes impd a clock, so this test boots impd itself with no clock.
test('it closes the database it opened itself when it stops', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'create-impd-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  // below the imps' port range, where the config refuses impd's own ports
  const ports = claimFreePorts(3, { pick: () => 10_000 + Math.floor(Math.random() * 10_000) });

  const config = {
    ...loadConfig({
      IMP_DATA_DIR: dataDir,
      IMP_JAILER: 'false',
      IMP_BOOT_TEMPLATES: 'false',
      IMP_SSH_PORT: '0',
      IMP_API_PORT: String(ports.take()),
      IMP_BROKER_PORT: String(ports.take()),
      IMP_EGRESS_DNS_PORT: String(ports.take()),
    }),
    defaultDiskBytes: 0,
  };

  const drive = 'd1'.repeat(32);
  const systemDrivePath = buildSystemDrivePath(dataDir, drive);

  await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
  await writeFile(systemDrivePath, drive);

  const vmm = buildStubVmm();

  const impd = await createImpd(config, {
    rootToken: TEST_TOKEN,
    storage: createXfsBackend({ dataDir, cloneFile: (source, target) => copyFile(source, target) }),
    systemFiles: {
      kernelPath: join(dataDir, 'system', 'vmlinux'),
      systemDrivePath,
      info: {
        guestKernel: { version: '6.1.188', sha256: 'a'.repeat(64) },
        systemDrive: { sha256: drive },
      },
    },
    readDiskSpace: () => Promise.resolve({ usedBytes: 0, availableBytes: 1024 ** 4 }),
    log: () => {},
    readIdentity: (files, ipv6Prefix) => ({
      firecrackerVersion: 'v1.17.0',
      snapshotVersion: 'v12.0.0',
      hostKernel: 'test',
      guestKernel: files.info.guestKernel.sha256,
      systemDrive: files.info.systemDrive.sha256,
      systemDrivePath: files.systemDrivePath,
      cpuModel: 'Test CPU',
      cpuFlags: 'test-flags',
      ipv6Prefix,
    }),
    resolveIpv6: () => Promise.resolve(null),
    readTailscale: readNoTailscale,
    cgroups: buildStubCpuCgroups().cgroups,
    vms: vmm.startGeneration(),
    taps: { setupTap: () => Promise.resolve(), removeTap: () => Promise.resolve() },
    broker: {
      installBundle: () => Promise.resolve(),
      resolveTunnelTarget: () => Promise.reject(new Error('no network in tests')),
      runOAuthTimer: false,
    },
    egress: {
      runNft: () => Promise.resolve(),
      flushConnections: () => Promise.resolve(),
      flushPair: () => Promise.resolve(),
      readForwardRules: () => Promise.resolve(''),
      forward: () => Promise.reject(new Error('no upstream in tests')),
      resolveExact: () => Promise.resolve([]),
    },
    reach: {
      readConnected4: () => Promise.resolve(['172.17.0.0/16']),
      readConnected6: () => Promise.resolve([]),
      readUplinks: () => Promise.resolve({ ipv4: ['eth0'], ipv6: [] }),
    },
    imps: {
      readRamMib: (pid) => (vmm.alive.has(pid) ? 300 : null),
      readRssMib: (pid) => (vmm.alive.has(pid) ? 340 : null),
      growFilesystem: () => Promise.resolve(false),
      hostCpus: 8,
    },
    freezer: { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() },
    tickerTimer: buildStubTickerTimer().timer,
    proxyPorts: { proxy: 0, slot: () => 0 },
    images: { seedRef: null },
  });

  await impd.stop({ sleepImps: false });

  expect(impd.db.selectFrom('imps').select('id').execute()).rejects.toThrow();
});

test('it sets a lease end from the wall clock when no clock is given', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'create-impd-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  // below the imps' port range, where the config refuses impd's own ports
  const ports = claimFreePorts(3, { pick: () => 10_000 + Math.floor(Math.random() * 10_000) });

  const config = {
    ...loadConfig({
      IMP_DATA_DIR: dataDir,
      IMP_JAILER: 'false',
      IMP_BOOT_TEMPLATES: 'false',
      IMP_SSH_PORT: '0',
      IMP_API_PORT: String(ports.take()),
      IMP_BROKER_PORT: String(ports.take()),
      IMP_EGRESS_DNS_PORT: String(ports.take()),
    }),
    defaultDiskBytes: 0,
  };

  const drive = 'd1'.repeat(32);
  const systemDrivePath = buildSystemDrivePath(dataDir, drive);

  await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
  await writeFile(systemDrivePath, drive);

  const vmm = buildStubVmm();

  const impd = await createImpd(config, {
    db,
    rootToken: TEST_TOKEN,
    storage: createXfsBackend({ dataDir, cloneFile: (source, target) => copyFile(source, target) }),
    systemFiles: {
      kernelPath: join(dataDir, 'system', 'vmlinux'),
      systemDrivePath,
      info: {
        guestKernel: { version: '6.1.188', sha256: 'a'.repeat(64) },
        systemDrive: { sha256: drive },
      },
    },
    readDiskSpace: () => Promise.resolve({ usedBytes: 0, availableBytes: 1024 ** 4 }),
    log: () => {},
    readIdentity: (files, ipv6Prefix) => ({
      firecrackerVersion: 'v1.17.0',
      snapshotVersion: 'v12.0.0',
      hostKernel: 'test',
      guestKernel: files.info.guestKernel.sha256,
      systemDrive: files.info.systemDrive.sha256,
      systemDrivePath: files.systemDrivePath,
      cpuModel: 'Test CPU',
      cpuFlags: 'test-flags',
      ipv6Prefix,
    }),
    resolveIpv6: () => Promise.resolve(null),
    readTailscale: readNoTailscale,
    cgroups: buildStubCpuCgroups().cgroups,
    vms: vmm.startGeneration(),
    taps: { setupTap: () => Promise.resolve(), removeTap: () => Promise.resolve() },
    broker: {
      installBundle: () => Promise.resolve(),
      resolveTunnelTarget: () => Promise.reject(new Error('no network in tests')),
      runOAuthTimer: false,
    },
    egress: {
      runNft: () => Promise.resolve(),
      flushConnections: () => Promise.resolve(),
      flushPair: () => Promise.resolve(),
      readForwardRules: () => Promise.resolve(''),
      forward: () => Promise.reject(new Error('no upstream in tests')),
      resolveExact: () => Promise.resolve([]),
    },
    reach: {
      readConnected4: () => Promise.resolve(['172.17.0.0/16']),
      readConnected6: () => Promise.resolve([]),
      readUplinks: () => Promise.resolve({ ipv4: ['eth0'], ipv6: [] }),
    },
    imps: {
      readRamMib: (pid) => (vmm.alive.has(pid) ? 300 : null),
      readRssMib: (pid) => (vmm.alive.has(pid) ? 340 : null),
      growFilesystem: () => Promise.resolve(false),
      hostCpus: 8,
    },
    freezer: { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() },
    tickerTimer: buildStubTickerTimer().timer,
    proxyPorts: { proxy: 0, slot: () => 0 },
    images: { seedRef: null },
  });

  stack.defer(async () => {
    await impd.stop({ sleepImps: false });
  });

  await Bun.write(join(dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(
    db,
    buildMockNewImage({ name: 'ubuntu', digest: 'sha256:ubuntu', sizeBytes: 6 }),
  );

  await impd.imps.createImp({ name: 'dev' });

  const startedMs = Date.now();

  const acquired = await impd.imps.acquireLease(
    'dev',
    { principal: 'root', display: 'root' },
    'job',
    30,
  );

  expect(acquired.lease.until?.getTime()).toBeWithin(startedMs + 30_000, Date.now() + 30_001);
});

// The test harness waits for the default image's seed, so this test boots impd itself.
test('it answers /health without a token, not ready before the default image is seeded', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'create-impd-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  // the stub docker's pull of the seed holds until its directory goes
  const dockerDir = await mkdtemp(join(tmpdir(), 'create-impd-docker-'));

  const docker = createStubDockerCli({
    directory: dockerDir,
    images: [
      {
        refs: ['seed.test/ubuntu:24.04'],
        inspects: [{ Id: `sha256:${'c'.repeat(64)}` }],
        isOnHost: false,
        pull: 'hang',
      },
    ],
  });

  updateEnv('PATH', docker.path);

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  // below the imps' port range, where the config refuses impd's own ports
  const ports = claimFreePorts(3, { pick: () => 10_000 + Math.floor(Math.random() * 10_000) });

  const config = {
    ...loadConfig({
      IMP_DATA_DIR: dataDir,
      IMP_JAILER: 'false',
      IMP_BOOT_TEMPLATES: 'false',
      IMP_BUILD_ISOLATION: 'host',
      IMP_SSH_PORT: '0',
      IMP_API_PORT: String(ports.take()),
      IMP_BROKER_PORT: String(ports.take()),
      IMP_EGRESS_DNS_PORT: String(ports.take()),
    }),
    defaultDiskBytes: 0,
  };

  const drive = 'd1'.repeat(32);
  const systemDrivePath = buildSystemDrivePath(dataDir, drive);

  await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
  await writeFile(systemDrivePath, drive);

  const vmm = buildStubVmm();

  const impd = await createImpd(config, {
    db,
    rootToken: TEST_TOKEN,
    storage: createXfsBackend({ dataDir, cloneFile: (source, target) => copyFile(source, target) }),
    systemFiles: {
      kernelPath: join(dataDir, 'system', 'vmlinux'),
      systemDrivePath,
      info: {
        guestKernel: { version: '6.1.188', sha256: 'a'.repeat(64) },
        systemDrive: { sha256: drive },
      },
    },
    readDiskSpace: () => Promise.resolve({ usedBytes: 0, availableBytes: 1024 ** 4 }),
    log: () => {},
    readIdentity: (files, ipv6Prefix) => ({
      firecrackerVersion: 'v1.17.0',
      snapshotVersion: 'v12.0.0',
      hostKernel: 'test',
      guestKernel: files.info.guestKernel.sha256,
      systemDrive: files.info.systemDrive.sha256,
      systemDrivePath: files.systemDrivePath,
      cpuModel: 'Test CPU',
      cpuFlags: 'test-flags',
      ipv6Prefix,
    }),
    resolveIpv6: () => Promise.resolve(null),
    readTailscale: readNoTailscale,
    cgroups: buildStubCpuCgroups().cgroups,
    vms: vmm.startGeneration(),
    taps: { setupTap: () => Promise.resolve(), removeTap: () => Promise.resolve() },
    broker: {
      installBundle: () => Promise.resolve(),
      resolveTunnelTarget: () => Promise.reject(new Error('no network in tests')),
      runOAuthTimer: false,
    },
    egress: {
      runNft: () => Promise.resolve(),
      flushConnections: () => Promise.resolve(),
      flushPair: () => Promise.resolve(),
      readForwardRules: () => Promise.resolve(''),
      forward: () => Promise.reject(new Error('no upstream in tests')),
      resolveExact: () => Promise.resolve([]),
    },
    reach: {
      readConnected4: () => Promise.resolve(['172.17.0.0/16']),
      readConnected6: () => Promise.resolve([]),
      readUplinks: () => Promise.resolve({ ipv4: ['eth0'], ipv6: [] }),
    },
    imps: {
      readRamMib: (pid) => (vmm.alive.has(pid) ? 300 : null),
      readRssMib: (pid) => (vmm.alive.has(pid) ? 340 : null),
      growFilesystem: () => Promise.resolve(false),
      hostCpus: 8,
    },
    freezer: { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() },
    tickerTimer: buildStubTickerTimer().timer,
    proxyPorts: { proxy: 0, slot: () => 0 },
    images: { seedRef: 'seed.test/ubuntu:24.04' },
  });

  stack.defer(async () => {
    await impd.stop({ sleepImps: false });
  });

  // deferred last, so the held pull ends and the seed fails before impd stops
  stack.defer(() => rm(dockerDir, { recursive: true, force: true }));

  await waitFor(() => {
    expect(docker.readCalls()).toContainEqual(expect.toStartWith('pull'));
  });

  const response = await impd.api.app.handle(new Request('http://impd.test/health'));
  const body: unknown = await response.json();

  expect(body).toStrictEqual({ status: 'ok', ready: false, warnings: [] });
});

test('it sends a streamed build its progress at the keepalive gap it is given', async () => {
  const repeat = buildStubRepeat();

  const ctx = await setupTest({ boundaries: { keepaliveMs: 20, keepaliveRepeat: repeat.repeat } });

  const upload = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();

  const context = new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(new TextEncoder().encode('tar'));
      upload.resolve(controller);
    },
  });

  const uploading = await upload.promise;

  onTestFinished(() => {
    uploading.close();
  });

  const init: RequestInit & { readonly duplex: 'half' } = {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TEST_TOKEN}`,
      'content-type': 'application/x-tar',
      accept: IMAGE_BUILD_STREAM_TYPE,
    },
    body: context,
    duplex: 'half',
  };

  const response = await ctx.impd.api.app.handle(
    new Request('http://impd.test/images/build?name=web', init),
  );

  const body: ReadableStream<Uint8Array> | null = response.body;

  invariant(body);

  const reader = body.getReader();

  onTestFinished(() => reader.cancel());

  repeat.tick(20);
  repeat.tick(20);
  repeat.tick(20);

  const first = await reader.read();
  const second = await reader.read();
  const third = await reader.read();
  const fourth = await reader.read();

  const events = [first, second, third, fourth].map(
    (chunk) => JSON.parse(new TextDecoder().decode(chunk.value)) as unknown,
  );

  expect(events).toStrictEqual([
    { type: 'progress', phase: 'upload', elapsedMs: 0 },
    { type: 'progress', phase: 'upload', elapsedMs: 0 },
    { type: 'progress', phase: 'upload', elapsedMs: 0 },
    { type: 'progress', phase: 'upload', elapsedMs: 0 },
  ]);
});

// a fresh Bun loads impd from source, which took up to 9 s on a 2 GiB host
// straight after a type check, past the 5 s default
test('it logs to stdout when no log is given', async () => {
  const ctx = await setupTest();

  const script = `
    import { loadConfig } from './config';
    import { createImpd } from './create-impd';
    import { openDatabase } from './platform/db/open-database';
    import { createXfsBackend } from './vm/storage/xfs-backend';

    const dataDir = ${JSON.stringify(ctx.dataDir)};

    await createImpd(loadConfig({ IMP_DATA_DIR: dataDir, IMP_BUILD_ISOLATION: 'host' }), {
      db: await openDatabase(':memory:'),
      rootToken: 'root-token',
      storage: createXfsBackend({ dataDir: dataDir + '/child' }),
      systemFiles: { kernelPath: '', systemDrivePath: '', info: ${JSON.stringify({
        guestKernel: { version: '6.1.188', sha256: 'a'.repeat(64) },
        systemDrive: { sha256: 'b'.repeat(64) },
      })} },

      // a CapEff with CAP_SETFCAP, so no capability warning comes first
      readProcStatus: () => 'CapEff:\\t00000000882810fb\\n',

      // the host warnings come before the IPv6 plan; the boot ends there
      resolveIpv6: () => process.exit(0),
    });
  `;

  const child = Bun.spawn(['bun', '-e', script], { cwd: import.meta.dir, stdout: 'pipe' });

  onTestFinished(() => {
    child.kill();
  });

  const stdout = await new Response(child.stdout).text();

  expect(stdout).toStartWith(`${HOST_BUILD_WARNING}\n${HOST_ADD_WARNING}\n`);
}, 30_000);
