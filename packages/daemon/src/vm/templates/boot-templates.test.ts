import { expect, mock, onTestFinished, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { captureImpdLogs } from '../../../testing/platform/capture-impd-logs';
import { buildMockHostIdentity } from '../../../testing/vm/build-mock-host-identity';
import { buildStubTemplateVm } from '../../../testing/vm/build-stub-template-vm';
import { createDiskBudget } from '../storage/disk-budget';
import { createBootTemplates } from './boot-templates';
import type { BootTemplateDeps } from './boot-templates';
import { buildTemplateKey } from './build-template-key';
import type { MemoryLockResult } from './create-memory-lock';

async function setupTest() {
  const dataDir = await mkdtemp(join(tmpdir(), 'boot-templates-'));

  onTestFinished(() => rm(dataDir, { recursive: true, force: true }));

  const logs = captureImpdLogs();
  const clock = { durationMs: Date.UTC(2026, 0, 1) };

  const diskBudget = createDiskBudget({
    storage: { readUsage: () => Promise.resolve({ usedBytes: 0, availableBytes: 1024 ** 4 }) },
    reserveBytes: null,
  });

  const vm = buildStubTemplateVm(diskBudget);

  const deps = {
    dataDir,
    firecrackerBin: 'firecracker',
    kernelPath: 'vmlinux',
    minGuestUptimeMs: 1500,
    ramBudgetMib: 8192,
    buildVm: vm.buildVm,
    lockMemory: mock(() => Promise.resolve({ lock: { lockedBytes: 0, release: () => {} } })),
    taps: { setupTap: mock(() => Promise.resolve()), removeTap: mock(() => Promise.resolve()) },
    jail: null,
    cgroups: {
      setup: mock((impId: string) => ({
        procsPath: `/cg/${impId}/cgroup.procs`,
        liftLimit: () => {},
        applyLimit: () => {},
      })),
      remove: mock(() => Promise.resolve()),
    },
    admission: { admit: mock(() => Promise.resolve()), release: mock(() => {}) },
    diskBudget,
    now: () => clock.durationMs,
  } satisfies Omit<BootTemplateDeps, 'identity' | 'bootReservePercent'>;

  return {
    dataDir,
    deps,
    diskBudget,
    vm,
    logs,
    advance: (durationMs: number) => {
      clock.durationMs += durationMs;
    },
  };
}

test('#buildTemplate builds a 2M shape on 2 MiB pages and records them in its files', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512, hugePages: '2M' });

  expect(ctx.vm.builds.map((plan) => plan.hugePages)).toStrictEqual(['2M']);
  expect(files.hugePages).toBe('2M');
});

test('#requestTemplate answers no 4 KiB template for a 2M shape', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(store.requestTemplate({ vcpus: 1, memoryMib: 512, hugePages: '2M' })).toBeNull();
});

test('#requestTemplate answers null and starts no build on the first miss of a shape', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  const found = store.requestTemplate({ vcpus: 1, memoryMib: 512 });

  await store.stop();

  expect(found).toBeNull();
  expect(ctx.vm.builds).toStrictEqual([]);
});

test('#requestTemplate starts one build on the second miss of a shape, shared by the misses after it', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  store.requestTemplate({ vcpus: 1, memoryMib: 512 });
  store.requestTemplate({ vcpus: 1, memoryMib: 512 });
  store.requestTemplate({ vcpus: 1, memoryMib: 512 });

  await store.stop();

  expect(ctx.vm.builds).toHaveLength(1);
});

test('#requestTemplate answers the template a build made', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(store.requestTemplate({ vcpus: 1, memoryMib: 512 })).toStrictEqual(files);
});

test('#readReadyCount counts each template a build left ready', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 });
  await store.buildTemplate({ vcpus: 2, memoryMib: 1024 });

  expect(store.readReadyCount()).toBe(2);
});

test('#readReadyCount counts no template before any build', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  expect(store.readReadyCount()).toBe(0);
});

test('#readReadyCount leaves out a template whose memory file is gone', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  const broken = await store.buildTemplate({ vcpus: 2, memoryMib: 1024 });

  rmSync(broken.memFile);

  expect(store.readReadyCount()).toBe(1);
});

test('#buildTemplate names the template by its key', async () => {
  const ctx = await setupTest();

  const identity = buildMockHostIdentity();
  const store = createBootTemplates({ ...ctx.deps, identity, bootReservePercent: 50 });

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(files.key).toBe(buildTemplateKey(identity, { vcpus: 1, memoryMib: 512 }));
});

test('#buildTemplate takes free RAM only, for its boot reserve of its memory', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(ctx.deps.admission.admit).toHaveBeenCalledExactlyOnceWith({
    id: `template-${files.key.slice(0, 12)}`,
    name: null,
    reserveMib: 256,
    memoryMib: 512,
    maySleepImps: false,
    isBackground: true,
    hugePagesMib: 0,
  });
});

test('#buildTemplate admits a 2M template against the huge page pool for all its memory', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512, hugePages: '2M' });

  expect(ctx.deps.admission.admit).toHaveBeenCalledExactlyOnceWith({
    id: `template-${files.key.slice(0, 12)}`,
    name: null,
    reserveMib: 256,
    memoryMib: 512,
    maySleepImps: false,
    isBackground: true,
    hugePagesMib: 512,
  });
});

test('#buildTemplate gives back the RAM it took once the build is done', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(ctx.deps.admission.release).toHaveBeenCalledExactlyOnceWith(
    `template-${files.key.slice(0, 12)}`,
  );

  expect(ctx.deps.admission.release).toHaveBeenCalledAfter(ctx.deps.admission.admit);
});

test('#buildTemplate holds disk room for its whole memory through the build only', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  const after = await ctx.diskBudget.readStatus();

  expect(ctx.vm.pendingAtBuild).toStrictEqual([512 * 1024 ** 2]);
  expect(after.pendingBytes).toBe(0);
});

test('#buildTemplate leaves only the template and the placeholder disk', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(readdirSync(join(ctx.dataDir, 'templates'))).toIncludeSameMembers([
    'placeholder.ext4',
    files.key,
  ]);
});

test('#buildTemplate names the same placeholder disk in every build', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 });
  await store.buildTemplate({ vcpus: 1, memoryMib: 1024 });

  expect(ctx.vm.builds.map((plan) => plan.placeholderPath)).toStrictEqual([
    join(ctx.dataDir, 'templates', 'placeholder.ext4'),
    join(ctx.dataDir, 'templates', 'placeholder.ext4'),
  ]);
});

test('#buildTemplate boots a parked agent with no imp address', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  const [plan] = ctx.vm.builds;

  invariant(plan);

  const args = plan.bootArgs.split(' ');

  expect(args).toContain('imp.template=1');
  expect(args.filter((arg) => arg.startsWith('imp.ip'))).toStrictEqual([]);
});

test('#buildTemplate runs a jailed build as the build uid in a cgroup of its own', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
    jail: { uid: 899_999, gid: 899_999 },
  });

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  const [plan] = ctx.vm.builds;

  invariant(plan);

  expect(plan).toMatchObject({
    jailId: 'tpl-build',
    jail: { uid: 899_999, gid: 899_999 },
    cgroup: { procsPath: '/cg/tpl-build/cgroup.procs' },
    workDir: expect.stringContaining(join(ctx.dataDir, 'templates', '.build-')) as unknown,
    paths: { runDir: join(plan.workDir, 'run') },
  });
});

test('#buildTemplate gives a jailed build its tap, owned by the build uid', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
    jail: { uid: 899_999, gid: 899_999 },
  });

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(ctx.deps.taps.setupTap).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ tap: 'imp-tpl' }),
    { uid: 899_999, gid: 899_999 },
  );
});

test('#buildTemplate sizes the cgroup of a jailed build to its memory after its tap', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
    jail: { uid: 899_999, gid: 899_999 },
  });

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(ctx.deps.cgroups.setup).toHaveBeenCalledExactlyOnceWith(
    'tpl-build',
    expect.anything(),
    512,
  );

  expect(ctx.deps.cgroups.setup).toHaveBeenCalledAfter(ctx.deps.taps.setupTap);
});

test('#buildTemplate removes the cgroup of a jailed build once the build is done', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
    jail: { uid: 899_999, gid: 899_999 },
  });

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(ctx.deps.cgroups.remove).toHaveBeenCalledExactlyOnceWith('tpl-build');
  expect(ctx.deps.cgroups.remove).toHaveBeenCalledAfter(ctx.deps.cgroups.setup);
});

test('#buildTemplate returns the drive and the placeholder a restore reopens', async () => {
  const ctx = await setupTest();

  const identity = buildMockHostIdentity();
  const store = createBootTemplates({ ...ctx.deps, identity, bootReservePercent: 50 });

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(files).toMatchObject({
    systemDrivePath: identity.systemDrivePath,
    placeholderPath: join(ctx.dataDir, 'templates', 'placeholder.ext4'),
  });
});

test('#buildTemplate refuses a jailed build without its cgroup before any VM starts', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
    jail: { uid: 899_999, gid: 899_999 },
    cgroups: { setup: () => null, remove: () => Promise.resolve() },
  });

  const building = store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(building).rejects.toThrowWithMessage(
    Error,
    'a jailed template build needs its own cgroup, and it has none',
  );

  expect(ctx.vm.builds).toStrictEqual([]);
});

test('#buildTemplate leaves no template behind a failed build', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
    buildVm: () => Promise.reject(new Error('no agent')),
  });

  const building = store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  await building.catch(() => {});

  expect(building).rejects.toThrowWithMessage(Error, 'no agent');
  expect(readdirSync(join(ctx.dataDir, 'templates'))).toStrictEqual(['placeholder.ext4']);
});

test('#requestTemplate starts no build while a failed build backs off', async () => {
  const ctx = await setupTest();

  const buildVm = mock(() => Promise.reject(new Error('no agent')));

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
    buildVm,
  });

  store.requestTemplate({ vcpus: 1, memoryMib: 512 });
  store.requestTemplate({ vcpus: 1, memoryMib: 512 });

  await store.stop();

  store.requestTemplate({ vcpus: 1, memoryMib: 512 });
  store.requestTemplate({ vcpus: 1, memoryMib: 512 });

  await store.stop();

  expect(buildVm).toHaveBeenCalledOnce();
});

test('#buildTemplate refuses a shape while its failed build backs off', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
    buildVm: () => Promise.reject(new Error('no agent')),
  });

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 }).catch(() => null);

  const building = store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(building).rejects.toThrowWithMessage(
    Error,
    'boot template builds of this shape back off; try again later',
  );
});

test('#requestTemplate builds again once the backoff after a failed build has passed', async () => {
  const ctx = await setupTest();

  const buildVm = mock(() => Promise.reject(new Error('no agent')));

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
    buildVm,
  });

  store.requestTemplate({ vcpus: 1, memoryMib: 512 });
  store.requestTemplate({ vcpus: 1, memoryMib: 512 });

  await store.stop();

  ctx.advance(60_000);
  store.requestTemplate({ vcpus: 1, memoryMib: 512 });

  await store.stop();

  expect(buildVm).toHaveBeenCalledTimes(2);
});

test('#buildTemplate turns a key off at its third failed build', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
    buildVm: () => Promise.reject(new Error('no agent')),
  });

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 }).catch(() => null);

  ctx.advance(60_000);

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 }).catch(() => null);

  ctx.advance(120_000);

  const building = store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  await building.catch(() => {});

  expect(building).rejects.toThrowWithMessage(Error, 'no agent');
  expect(ctx.logs.at(-1)).toInclude('build failed (off until impd restarts): no agent');
});

test('#buildTemplate refuses a key that is off however long it waits', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
    buildVm: () => Promise.reject(new Error('no agent')),
  });

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 }).catch(() => null);

  ctx.advance(60_000);

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 }).catch(() => null);

  ctx.advance(120_000);

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 }).catch(() => null);

  ctx.advance(3_600_000);

  const building = store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(building).rejects.toThrowWithMessage(
    Error,
    'boot templates of this shape are off until impd restarts',
  );
});

test('#requestTemplate starts no build for a key that is off', async () => {
  const ctx = await setupTest();

  const buildVm = mock(() => Promise.reject(new Error('no agent')));

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
    buildVm,
  });

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 }).catch(() => null);

  ctx.advance(60_000);

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 }).catch(() => null);

  ctx.advance(120_000);

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 }).catch(() => null);

  ctx.advance(3_600_000);
  store.requestTemplate({ vcpus: 1, memoryMib: 512 });
  store.requestTemplate({ vcpus: 1, memoryMib: 512 });

  await store.stop();

  expect(buildVm).toHaveBeenCalledTimes(3);
});

test('#buildTemplate refuses a build the RAM turns away with the admission error', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
    admission: { admit: () => Promise.reject(new Error('no room: ram')), release: () => {} },
  });

  const building = store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(building).rejects.toThrowWithMessage(Error, 'no room: ram');
});

test('#buildTemplate refuses a build the disk has no room for', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
    diskBudget: createDiskBudget({
      storage: { readUsage: () => Promise.resolve({ usedBytes: 0, availableBytes: 1024 ** 3 }) },
      reserveBytes: null,
    }),
  });

  const building = store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(building).rejects.toThrowWithMessage(
    Error,
    /^not enough free disk: 1\.0 GiB free, 0\.5 GiB wanted, /u,
  );
});

test('#buildTemplate backs off a minute after a refused build', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
    admission: { admit: () => Promise.reject(new Error('no room: ram')), release: () => {} },
  });

  const building = store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  await building.catch(() => {});

  expect(building).rejects.toThrowWithMessage(Error, 'no room: ram');
  expect(ctx.logs.at(-1)).toInclude('build refused (next try in 60s): no room: ram');
});

test('#buildTemplate gives back the admission of a refused build and leaves no work directory', async () => {
  const ctx = await setupTest();

  const release = mock(() => {});

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
    admission: { admit: () => Promise.reject(new Error('no room: ram')), release },
  });

  const building = store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  await building.catch(() => {});

  expect(building).rejects.toThrowWithMessage(Error, 'no room: ram');
  expect(release).toHaveBeenCalledOnce();
  expect(existsSync(join(ctx.dataDir, 'templates'))).toBeFalse();
});

test('#buildTemplate counts no refused build as a failure', async () => {
  const ctx = await setupTest();

  const admit = mock(() => Promise.resolve())
    .mockImplementationOnce(() => Promise.reject(new Error('no room: ram')))
    .mockImplementationOnce(() => Promise.reject(new Error('no room: ram')))
    .mockImplementationOnce(() => Promise.reject(new Error('no room: ram')))
    .mockImplementationOnce(() => Promise.reject(new Error('no room: ram')));

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
    admission: { admit, release: () => {} },
  });

  for (let count = 0; count < 4; count += 1) {
    await store.buildTemplate({ vcpus: 1, memoryMib: 512 }).catch(() => null);

    ctx.advance(60_000);
  }

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(existsSync(files.memFile)).toBeTrue();
});

test('#reportFailure keeps a template whose restore failed in the imp', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  store.reportFailure(files, { fault: null, restoredBefore: 0 });

  expect(existsSync(files.memFile)).toBeTrue();
});

test('#reportFailure removes a template whose restore failed in the template', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  store.reportFailure(files, { fault: 'load', restoredBefore: 0 });

  expect(existsSync(files.memFile)).toBeFalse();
});

test('#reportFailure keeps a template whose agent timed out while another restore of it succeeded', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  const restoredBefore = store.countRestored(files);

  store.reportRestored(files);
  store.reportFailure(files, { fault: 'agent', restoredBefore });

  expect(existsSync(files.memFile)).toBeTrue();
});

test('#reportFailure removes a template whose agent timed out with no restore of it succeeding', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  store.reportRestored(files);

  const restoredBefore = store.countRestored(files);

  store.reportFailure(files, { fault: 'agent', restoredBefore });

  expect(existsSync(files.memFile)).toBeFalse();
});

test('#reportFailure removes a template whose load failed, though another restore of it succeeded', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  const restoredBefore = store.countRestored(files);

  store.reportRestored(files);
  store.reportFailure(files, { fault: 'load', restoredBefore });

  expect(existsSync(files.memFile)).toBeFalse();
});

test('#reportFailure for an older build leaves the rebuilt template', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  const first = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  store.reportFailure(first, { fault: 'load', restoredBefore: 0 });

  const rebuilt = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  store.reportFailure(first, { fault: 'load', restoredBefore: 0 });

  expect(existsSync(rebuilt.memFile)).toBeTrue();
});

test('#reportFailure turns a key off at its third template fault in a row', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  for (let count = 0; count < 2; count += 1) {
    const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

    store.reportFailure(files, { fault: 'load', restoredBefore: 0 });
  }

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  store.reportFailure(files, { fault: 'load', restoredBefore: 0 });

  expect(ctx.logs.at(-1)).toInclude('off until impd restarts: 3 restores failed');
});

test('#buildTemplate refuses a key its restore faults turned off', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  for (let count = 0; count < 3; count += 1) {
    const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

    store.reportFailure(files, { fault: 'load', restoredBefore: 0 });
  }

  const building = store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(building).rejects.toThrowWithMessage(
    Error,
    'boot templates of this shape are off until impd restarts',
  );
});

test('#reportFailure counts no fault in the imp toward turning the key off', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  for (let count = 0; count < 2; count += 1) {
    const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

    store.reportFailure(files, { fault: 'load', restoredBefore: 0 });
  }

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  for (let count = 0; count < 5; count += 1) {
    store.reportFailure(files, { fault: null, restoredBefore: 0 });
  }

  expect(store.requestTemplate({ vcpus: 1, memoryMib: 512 })).toStrictEqual(files);
});

test('#reportRestored starts the count of template faults again', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  for (let count = 0; count < 2; count += 1) {
    const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

    store.reportFailure(files, { fault: 'load', restoredBefore: 0 });
  }

  const restored = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  store.reportRestored(restored);
  store.reportFailure(restored, { fault: 'load', restoredBefore: 0 });

  const rebuilt = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  store.reportFailure(rebuilt, { fault: 'load', restoredBefore: 0 });

  expect(ctx.logs.join('\n')).not.toInclude('restores failed');
});

test('#reportFailure counts no failure for a template evicted before it', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  for (let count = 0; count < 3; count += 1) {
    const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

    rmSync(join(ctx.dataDir, 'templates', files.key), { recursive: true });

    store.reportFailure(files, { fault: 'load', restoredBefore: 0 });
  }

  const rebuilt = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(store.requestTemplate({ vcpus: 1, memoryMib: 512 })).toStrictEqual(rebuilt);
});

test('#buildTemplate removes the least recently used template past four', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  for (const memoryMib of [256, 512, 768, 1024]) {
    await store.buildTemplate({ vcpus: 1, memoryMib });

    ctx.advance(1000);
  }

  store.requestTemplate({ vcpus: 1, memoryMib: 256 });
  ctx.advance(1000);

  await store.buildTemplate({ vcpus: 2, memoryMib: 256 });

  expect(store.requestTemplate({ vcpus: 1, memoryMib: 512 })).toBeNull();
  expect(store.requestTemplate({ vcpus: 1, memoryMib: 256 })).not.toBeNull();
  expect(store.requestTemplate({ vcpus: 1, memoryMib: 768 })).not.toBeNull();
  expect(store.requestTemplate({ vcpus: 1, memoryMib: 1024 })).not.toBeNull();
});

test('#buildTemplate logs the template it removes as least recently used', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  const oldest = await store.buildTemplate({ vcpus: 1, memoryMib: 256 });

  ctx.advance(1000);

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  ctx.advance(1000);

  await store.buildTemplate({ vcpus: 1, memoryMib: 768 });

  ctx.advance(1000);

  await store.buildTemplate({ vcpus: 1, memoryMib: 1024 });

  ctx.advance(1000);

  const lines = captureImpdLogs();

  await store.buildTemplate({ vcpus: 2, memoryMib: 256 });

  expect(lines).toContain(
    `INFO impd.boot removed boot template ${oldest.key.slice(0, 12)}: least recently used`,
  );
});

test('#removeStale removes the templates of another host identity', async () => {
  const ctx = await setupTest();

  const identity = buildMockHostIdentity();
  const store = createBootTemplates({ ...ctx.deps, identity, bootReservePercent: 50 });

  const old = createBootTemplates({
    ...ctx.deps,
    identity: { ...identity, systemDrive: 'd0', systemDrivePath: '/data/system/drives/d0' },
    bootReservePercent: 50,
  });

  const stale = await old.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(store.removeStale()).toStrictEqual([stale.key]);
});

test('#removeStale removes what a cut-short build left', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  mkdirSync(join(ctx.dataDir, 'templates', '.build-cut-short'));

  store.removeStale();

  expect(existsSync(join(ctx.dataDir, 'templates', '.build-cut-short'))).toBeFalse();
});

test('#removeStale never removes a current template or the placeholder disk', async () => {
  const ctx = await setupTest();

  const identity = buildMockHostIdentity();
  const store = createBootTemplates({ ...ctx.deps, identity, bootReservePercent: 50 });

  const current = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  const old = createBootTemplates({
    ...ctx.deps,
    identity: { ...identity, systemDrive: 'd0', systemDrivePath: '/data/system/drives/d0' },
    bootReservePercent: 50,
  });

  await old.buildTemplate({ vcpus: 1, memoryMib: 512 });

  store.removeStale();

  expect(readdirSync(join(ctx.dataDir, 'templates'))).toIncludeSameMembers([
    'placeholder.ext4',
    current.key,
  ]);
});

test('#removeStale answers no keys before any template exists', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  expect(store.removeStale()).toStrictEqual([]);
});

test('#listDrivePaths lists the system drive of every template', async () => {
  const ctx = await setupTest();

  const identity = buildMockHostIdentity({ systemDrivePath: '/data/system/drives/d1' });
  const store = createBootTemplates({ ...ctx.deps, identity, bootReservePercent: 50 });

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  const old = createBootTemplates({
    ...ctx.deps,
    identity: { ...identity, systemDrive: 'd0', systemDrivePath: '/data/system/drives/d0' },
    bootReservePercent: 50,
  });

  await old.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(store.listDrivePaths()).toIncludeSameMembers([
    '/data/system/drives/d1',
    '/data/system/drives/d0',
  ]);
});

test('#listDrivePaths drops the drive of a stale template once it is removed', async () => {
  const ctx = await setupTest();

  const identity = buildMockHostIdentity({ systemDrivePath: '/data/system/drives/d1' });
  const store = createBootTemplates({ ...ctx.deps, identity, bootReservePercent: 50 });

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  const old = createBootTemplates({
    ...ctx.deps,
    identity: { ...identity, systemDrive: 'd0', systemDrivePath: '/data/system/drives/d0' },
    bootReservePercent: 50,
  });

  await old.buildTemplate({ vcpus: 1, memoryMib: 512 });

  store.removeStale();

  expect(store.listDrivePaths()).toStrictEqual(['/data/system/drives/d1']);
});

test('#buildTemplate locks the memory file of the template it built', async () => {
  const ctx = await setupTest();

  const lockMemory = mock(() =>
    Promise.resolve({ lock: { lockedBytes: 3 * 1024 * 1024, release: () => {} } }),
  );

  const store = createBootTemplates({
    ...ctx.deps,
    lockMemory,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  await store.stop();

  expect(lockMemory).toHaveBeenCalledExactlyOnceWith(files.memFile, expect.any(Function));
});

test('#buildTemplate locks a rebuilt template apart from the lock its removed build left', async () => {
  const ctx = await setupTest();

  const pending = Promise.withResolvers<MemoryLockResult>();
  const lockMemory = mock(() => pending.promise);

  const store = createBootTemplates({
    ...ctx.deps,
    lockMemory,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  const removed = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  store.reportFailure(removed, { fault: 'load', restoredBefore: 0 });

  const rebuilt = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  pending.resolve({ errno: 12 });

  await store.stop();

  expect(lockMemory).toHaveBeenCalledTimes(2);
  expect(lockMemory).toHaveBeenLastCalledWith(rebuilt.memFile, expect.any(Function));
});

test('#stop starts no lock of a kept template after it is called', async () => {
  const ctx = await setupTest();

  const identity = buildMockHostIdentity();
  const earlier = createBootTemplates({ ...ctx.deps, identity, bootReservePercent: 50 });

  await earlier.buildTemplate({ vcpus: 1, memoryMib: 512 });
  await earlier.buildTemplate({ vcpus: 2, memoryMib: 512 });
  await earlier.stop();

  const first = Promise.withResolvers<MemoryLockResult>();
  const lockMemory = mock(() => first.promise);
  const store = createBootTemplates({ ...ctx.deps, lockMemory, identity, bootReservePercent: 50 });
  const keeping = store.lockKept();
  const stopping = store.stop();

  first.resolve({ errno: 12 });

  await stopping;
  await keeping;

  expect(lockMemory).toHaveBeenCalledOnce();
});

test('#readLockedMib sums the locked memory of every template, in whole MiB', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    lockMemory: mock(() =>
      Promise.resolve({ lock: { lockedBytes: 1_500_000, release: () => {} } }),
    ),
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 });
  await store.buildTemplate({ vcpus: 2, memoryMib: 512 });
  await store.lockKept();

  expect(store.readLockedMib()).toBe(3);
});

test('#reportFailure releases the lock of the template it removes', async () => {
  const ctx = await setupTest();

  const release = mock(() => {});

  const store = createBootTemplates({
    ...ctx.deps,
    lockMemory: mock(() => Promise.resolve({ lock: { lockedBytes: 4096, release } })),
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  await store.lockKept();

  store.reportFailure(files, { fault: 'load', restoredBefore: 0 });

  expect(release).toHaveBeenCalledOnce();
  expect(store.readLockedMib()).toBe(0);
});

test('#reportFailure releases a lock that finishes after it removed the template', async () => {
  const ctx = await setupTest();

  const release = mock(() => {});
  const pending = Promise.withResolvers<{ lock: { lockedBytes: number; release: () => void } }>();

  const store = createBootTemplates({
    ...ctx.deps,
    lockMemory: mock(() => pending.promise),
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  store.reportFailure(files, { fault: 'load', restoredBefore: 0 });
  pending.resolve({ lock: { lockedBytes: 4096, release } });

  await store.stop();

  expect(release).toHaveBeenCalledOnce();
});

test('#lockKept locks each template that an earlier impd built', async () => {
  const ctx = await setupTest();

  const identity = buildMockHostIdentity();
  const earlier = createBootTemplates({ ...ctx.deps, identity, bootReservePercent: 50 });

  const files = await earlier.buildTemplate({ vcpus: 1, memoryMib: 512 });

  await earlier.stop();

  const lockMemory = mock(() =>
    Promise.resolve({ lock: { lockedBytes: 4096, release: () => {} } }),
  );

  const store = createBootTemplates({ ...ctx.deps, lockMemory, identity, bootReservePercent: 50 });

  await store.lockKept();

  expect(lockMemory).toHaveBeenCalledExactlyOnceWith(files.memFile, expect.any(Function));
});

test('#lockKept leaves a template unlocked and restorable when its lock fails', async () => {
  const ctx = await setupTest();

  const identity = buildMockHostIdentity();
  const earlier = createBootTemplates({ ...ctx.deps, identity, bootReservePercent: 50 });

  const files = await earlier.buildTemplate({ vcpus: 1, memoryMib: 512 });

  await earlier.stop();

  const store = createBootTemplates({
    ...ctx.deps,
    lockMemory: mock(() => Promise.resolve({ errno: 12 })),
    identity,
    bootReservePercent: 50,
  });

  await store.lockKept();

  expect(ctx.logs.at(-1)).toInclude('memory not locked (errno 12)');
  expect(store.readLockedMib()).toBe(0);
  expect(store.requestTemplate({ vcpus: 1, memoryMib: 512 })).toStrictEqual(files);
});

test('#stop releases the lock of every template', async () => {
  const ctx = await setupTest();

  const release = mock(() => {});

  const store = createBootTemplates({
    ...ctx.deps,
    lockMemory: mock(() => Promise.resolve({ lock: { lockedBytes: 4096, release } })),
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 });
  await store.stop();

  expect(release).toHaveBeenCalledOnce();
  expect(store.readLockedMib()).toBe(0);
});
