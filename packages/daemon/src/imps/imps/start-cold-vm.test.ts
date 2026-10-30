import { expect, onTestFinished, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { waitFor } from '@impz/test-utils/wait-for';
import { ORPCError } from '@orpc/client';
import invariant from 'tiny-invariant';
import { buildStubDiskTools } from '../../../testing/imps/build-stub-disk-tools';
import { readBrokenInvariants } from '../../../testing/imps/read-broken-invariants';
import { waitForOutcome } from '../../../testing/imps/wait-for-outcome';
import { startTestImpd } from '../../../testing/start-test-impd';
import { buildStubCpuCgroups } from '../../../testing/vm/build-stub-cpu-cgroups';
import { listImps, readImpByName } from '../../platform/db/imps';
import { buildTemplateKey } from '../../vm/templates/build-template-key';

async function setupTest(
  config: Readonly<{
    isJailed?: boolean;
  }> = {},
) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const isJailed = config.isJailed ?? false;
  const cgroups = buildStubCpuCgroups();
  const disk = buildStubDiskTools();

  const harness = await startTestImpd(stack, {
    ...(isJailed && { cgroups: cgroups.cgroups }),
    env: {
      IMP_BOOT_TEMPLATES: 'true',
      IMP_JAILER: String(isJailed),
    },
    cloneDisk: disk.cloneDisk,
    growFilesystem: disk.growFilesystem,
  });

  const templates = harness.imps.bootTemplates;

  invariant(templates, 'IMP_BOOT_TEMPLATES is on, but impd has no templates');

  return Object.assign(harness, { templates, disk, stack });
}

test('it boots the kernel for the first boot of a shape and builds no template', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'once', vcpus: 1, memoryMib: 256 });

  expect(ctx.fake.boots.map((boot) => boot.hostname)).toStrictEqual(['once']);
  expect(ctx.fake.templateBuilds).toBeEmpty();
});

test('it builds the template on the second boot of a shape, and the next restores it', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'once', vcpus: 1, memoryMib: 256 });
  await ctx.client.imps.create({ name: 'first', vcpus: 1, memoryMib: 256 });
  await ctx.templates.stop();
  await ctx.client.imps.create({ name: 'second', vcpus: 1, memoryMib: 256 });

  const key = buildTemplateKey(ctx.readIdentity(), { vcpus: 1, memoryMib: 256 });

  const second = await readImpByName(ctx.db, 'second');

  expect(ctx.fake.templateBuilds).toStrictEqual([{ vcpus: 1, memoryMib: 256 }]);
  expect(ctx.fake.boots.map((boot) => boot.hostname)).toStrictEqual(['once', 'first']);

  expect(ctx.fake.restores).toStrictEqual([
    {
      hostname: 'second',
      isIdentityReset: false,
      memFile: join(ctx.dataDir, 'templates', key, 'mem'),
    },
  ]);

  expect(second?.state).toBe('running');

  expect(ctx.logs).toSatisfyAny((line: string) =>
    line.startsWith(`INFO impd.imps imp=second restored boot template ${key.slice(0, 12)} as pid `),
  );
});

test('it logs the guest steps after the host steps of a restore', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'once', vcpus: 1, memoryMib: 256 });
  await ctx.client.imps.create({ name: 'first', vcpus: 1, memoryMib: 256 });
  await ctx.templates.stop();

  ctx.fake.setGuestBootSteps({ claim: 3, mount: 40, grow: 0, ready: 2 });

  await ctx.client.imps.create({ name: 'second', vcpus: 1, memoryMib: 256 });

  expect(ctx.logs).toSatisfyAny(
    (line: string) =>
      line.startsWith('INFO impd.imps imp=second restored boot template ') &&
      line.endsWith('; guest claim=3ms mount=40ms grow=0ms ready=2ms'),
  );
});

test('it logs the guest steps after the host steps of a kernel boot', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  ctx.fake.setGuestBootSteps({ world: 9, mount: 35, ready: 1 });

  await ctx.client.imps.create({ name: 'once', vcpus: 1, memoryMib: 256 });

  expect(ctx.logs).toSatisfyAny(
    (line: string) =>
      line.startsWith('INFO impd.imps imp=once booted pid ') &&
      line.endsWith('; guest world=9ms mount=35ms ready=1ms'),
  );
});

test('it leaves no broken record behind once a restored imp settles', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'once', vcpus: 1, memoryMib: 256 });
  await ctx.client.imps.create({ name: 'first', vcpus: 1, memoryMib: 256 });
  await ctx.templates.stop();
  await ctx.client.imps.create({ name: 'second', vcpus: 1, memoryMib: 256 });
  await ctx.imps.waitForLifecycle();

  const broken = await readBrokenInvariants(ctx, false);

  expect(ctx.fake.restores.map((restore) => restore.hostname)).toStrictEqual(['second']);
  expect(ctx.fake.boots.map((boot) => boot.hostname)).toStrictEqual(['once', 'first']);
  expect(broken).toBeEmpty();
});

test('it boots the kernel for an elastic imp even when its memory has a template', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'first', vcpus: 1, memoryMib: 256 });
  await ctx.templates.buildTemplate({ vcpus: 1, memoryMib: 256 });
  await ctx.client.imps.create({ name: 'elastic', vcpus: 1, memoryMib: 256, maxMemoryMib: 1024 });
  await ctx.client.imps.create({ name: 'plain', vcpus: 1, memoryMib: 256 });

  expect(ctx.fake.boots.map((boot) => boot.hostname)).toStrictEqual(['first', 'elastic']);
  expect(ctx.fake.restores.map((restore) => restore.hostname)).toStrictEqual(['plain']);
  expect(ctx.fake.templateBuilds).toStrictEqual([{ vcpus: 1, memoryMib: 256 }]);
});

test('it removes a template whose restore fails in it, and boots the kernel', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'first', vcpus: 1, memoryMib: 256 });
  await ctx.templates.buildTemplate({ vcpus: 1, memoryMib: 256 });

  ctx.fake.queue('restore', 'fail');

  const second = await ctx.client.imps.create({ name: 'second', vcpus: 1, memoryMib: 256 });

  const key = buildTemplateKey(ctx.readIdentity(), { vcpus: 1, memoryMib: 256 });

  expect(second.state).toBe('running');
  expect(ctx.fake.boots.map((boot) => boot.hostname)).toStrictEqual(['first', 'second']);

  expect(ctx.logs).toSatisfyAny(
    (line: string) =>
      line.includes('failed, booting the kernel') && line.includes(key.slice(0, 12)),
  );

  expect(readdirSync(join(ctx.dataDir, 'templates'))).not.toContain(key);
});

test('it removes a template whose parked agent never answers, though an earlier restore of it succeeded', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'first', vcpus: 1, memoryMib: 256 });
  await ctx.templates.buildTemplate({ vcpus: 1, memoryMib: 256 });
  await ctx.client.imps.create({ name: 'second', vcpus: 1, memoryMib: 256 });

  ctx.fake.queue('parkedAgent', 'fail');

  await ctx.client.imps.create({ name: 'third', vcpus: 1, memoryMib: 256 });

  const key = buildTemplateKey(ctx.readIdentity(), { vcpus: 1, memoryMib: 256 });

  expect(ctx.fake.boots.map((boot) => boot.hostname)).toStrictEqual(['first', 'third']);
  expect(readdirSync(join(ctx.dataDir, 'templates'))).not.toContain(key);
});

test('it keeps a template whose parked agent timed out while another restore of it succeeded', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'first', vcpus: 1, memoryMib: 256 });
  await ctx.templates.buildTemplate({ vcpus: 1, memoryMib: 256 });

  ctx.fake.queue('restore', 'hang', 'ok');
  ctx.fake.queue('parkedAgent', 'ok', 'fail');

  const slow = ctx.client.imps.create({ name: 'slow', vcpus: 1, memoryMib: 256 });

  await waitFor(() => {
    expect(ctx.fake.countHungCalls()).toBe(1);
  });

  await ctx.client.imps.create({ name: 'quick', vcpus: 1, memoryMib: 256 });

  ctx.fake.releaseHangs();

  await slow;

  const key = buildTemplateKey(ctx.readIdentity(), { vcpus: 1, memoryMib: 256 });

  expect(ctx.fake.boots.map((boot) => boot.hostname)).toStrictEqual(['first', 'slow']);
  expect(readdirSync(join(ctx.dataDir, 'templates'))).toContain(key);
});

test('it keeps the template for the next imp after a restore fails past the claim', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'first', vcpus: 1, memoryMib: 256 });
  await ctx.templates.buildTemplate({ vcpus: 1, memoryMib: 256 });

  ctx.fake.queue('claim', 'fail');

  await ctx.client.imps.create({ name: 'second', vcpus: 1, memoryMib: 256 });
  await ctx.client.imps.create({ name: 'third', vcpus: 1, memoryMib: 256 });

  expect(ctx.fake.boots.map((boot) => boot.hostname)).toStrictEqual(['first', 'second']);
  expect(ctx.fake.restores.map((restore) => restore.hostname)).toStrictEqual(['third']);
  expect(ctx.fake.templateBuilds).toHaveLength(1);
});

test('it fails a create whose clone fails before any restore', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'first', vcpus: 1, memoryMib: 256 });
  await ctx.templates.buildTemplate({ vcpus: 1, memoryMib: 256 });

  ctx.disk.setCloneFailing(true);

  const creating = ctx.client.imps.create({ name: 'second', vcpus: 1, memoryMib: 256 });

  expect(creating).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  expect(ctx.fake.restorePlans).toBeEmpty();
});

test('it keeps the template through more failed clones than turn a key off', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'first', vcpus: 1, memoryMib: 256 });
  await ctx.templates.buildTemplate({ vcpus: 1, memoryMib: 256 });

  const aliveBefore = ctx.fake.alive.size;

  ctx.disk.setCloneFailing(true);

  const secondFailure = await ctx.client.imps
    .create({ name: 'second', vcpus: 1, memoryMib: 256 })
    .then(
      () => null,
      (error: unknown) => error,
    );

  const thirdFailure = await ctx.client.imps
    .create({ name: 'third', vcpus: 1, memoryMib: 256 })
    .then(
      () => null,
      (error: unknown) => error,
    );

  const fourthFailure = await ctx.client.imps
    .create({ name: 'fourth', vcpus: 1, memoryMib: 256 })
    .then(
      () => null,
      (error: unknown) => error,
    );

  const second = await readImpByName(ctx.db, 'second');
  const third = await readImpByName(ctx.db, 'third');
  const fourth = await readImpByName(ctx.db, 'fourth');

  const plansAfterFailures = [...ctx.fake.restorePlans];

  ctx.disk.setCloneFailing(false);

  await ctx.client.imps.create({ name: 'fifth', vcpus: 1, memoryMib: 256 });

  const key = buildTemplateKey(ctx.readIdentity(), { vcpus: 1, memoryMib: 256 });

  expect(secondFailure).toStrictEqual(
    new ORPCError('INTERNAL_SERVER_ERROR', { status: 500, message: 'Internal server error' }),
  );

  expect(thirdFailure).toStrictEqual(
    new ORPCError('INTERNAL_SERVER_ERROR', { status: 500, message: 'Internal server error' }),
  );

  expect(fourthFailure).toStrictEqual(
    new ORPCError('INTERNAL_SERVER_ERROR', { status: 500, message: 'Internal server error' }),
  );

  expect(second?.error).toBe('clone failed: no space');
  expect(third?.error).toBe('clone failed: no space');
  expect(fourth?.error).toBe('clone failed: no space');
  expect(plansAfterFailures).toBeEmpty();
  expect(ctx.fake.alive.size).toBe(aliveBefore + 1);
  expect(ctx.fake.boots.map((boot) => boot.hostname)).toStrictEqual(['first']);
  expect(readdirSync(join(ctx.dataDir, 'templates'))).toContain(key);
  expect(ctx.fake.restores.map((restore) => restore.hostname)).toStrictEqual(['fifth']);
});

test('it ends the restored VM when the grow after the clone fails, and keeps the template', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'first', vcpus: 1, memoryMib: 256 });
  await ctx.templates.buildTemplate({ vcpus: 1, memoryMib: 256 });

  const aliveBefore = ctx.fake.alive.size;

  ctx.disk.setCloneEmpty(true);

  const secondFailure = await ctx.client.imps
    .create({ name: 'second', vcpus: 1, memoryMib: 256 })
    .then(
      () => null,
      (error: unknown) => error,
    );

  const thirdFailure = await ctx.client.imps
    .create({ name: 'third', vcpus: 1, memoryMib: 256 })
    .then(
      () => null,
      (error: unknown) => error,
    );

  const fourthFailure = await ctx.client.imps
    .create({ name: 'fourth', vcpus: 1, memoryMib: 256 })
    .then(
      () => null,
      (error: unknown) => error,
    );

  const second = await readImpByName(ctx.db, 'second');
  const third = await readImpByName(ctx.db, 'third');
  const fourth = await readImpByName(ctx.db, 'fourth');

  ctx.disk.setCloneEmpty(false);

  await ctx.client.imps.create({ name: 'fifth', vcpus: 1, memoryMib: 256 });

  const key = buildTemplateKey(ctx.readIdentity(), { vcpus: 1, memoryMib: 256 });

  expect(secondFailure).toStrictEqual(
    new ORPCError('INTERNAL_SERVER_ERROR', { status: 500, message: 'Internal server error' }),
  );

  expect(thirdFailure).toStrictEqual(
    new ORPCError('INTERNAL_SERVER_ERROR', { status: 500, message: 'Internal server error' }),
  );

  expect(fourthFailure).toStrictEqual(
    new ORPCError('INTERNAL_SERVER_ERROR', { status: 500, message: 'Internal server error' }),
  );

  invariant(second);
  invariant(third);
  invariant(fourth);

  expect(second.error).toBe(
    `ENOENT: no such file or directory, stat '${join(ctx.dataDir, 'imps', second.id, 'disk.ext4')}'`,
  );

  expect(third.error).toBe(
    `ENOENT: no such file or directory, stat '${join(ctx.dataDir, 'imps', third.id, 'disk.ext4')}'`,
  );

  expect(fourth.error).toBe(
    `ENOENT: no such file or directory, stat '${join(ctx.dataDir, 'imps', fourth.id, 'disk.ext4')}'`,
  );

  expect(ctx.fake.restorePlans.map((plan) => plan.claim.hostname)).toStrictEqual([
    'second',
    'third',
    'fourth',
    'fifth',
  ]);

  expect(ctx.fake.alive.size).toBe(aliveBefore + 1);
  expect(ctx.fake.boots.map((boot) => boot.hostname)).toStrictEqual(['first']);
  expect(readdirSync(join(ctx.dataDir, 'templates'))).toContain(key);
  expect(ctx.fake.restores.map((restore) => restore.hostname)).toStrictEqual(['fifth']);
});

test('it claims the identity reset an imp owes with a restore, and clears it once done', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'first', vcpus: 1, memoryMib: 256 });
  await ctx.templates.buildTemplate({ vcpus: 1, memoryMib: 256 });
  await ctx.client.imps.stop({ name: 'first' });
  await ctx.db.updateTable('imps').set({ identity_reset_pending: 1 }).execute();
  await ctx.client.imps.start({ name: 'first' });

  const first = await readImpByName(ctx.db, 'first');

  expect(ctx.fake.restores.map((restore) => restore.isIdentityReset)).toStrictEqual([true]);
  expect(first?.isIdentityResetPending).toBe(false);
});

test('it never waits for the template build of a shape with no template yet', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const held = ctx.fake.hold('template');

  ctx.stack.defer(() => {
    held.release();
  });

  await ctx.client.imps.create({ name: 'once', vcpus: 1, memoryMib: 256 });

  const created = await ctx.client.imps.create({ name: 'first', vcpus: 1, memoryMib: 256 });

  await held.reached;

  expect(created.state).toBe('running');
});

test('it runs a jailed restore as the imp, with the template and its drive bound in', async () => {
  const ctx = await setupTest({ isJailed: true });

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'once', vcpus: 1, memoryMib: 256 });
  await ctx.client.imps.create({ name: 'first', vcpus: 1, memoryMib: 256 });
  await ctx.templates.stop();
  await ctx.client.imps.create({ name: 'second', vcpus: 1, memoryMib: 256 });

  const key = buildTemplateKey(ctx.readIdentity(), { vcpus: 1, memoryMib: 256 });

  const second = await readImpByName(ctx.db, 'second');

  const directory = join(ctx.dataDir, 'templates');

  invariant(typeof second?.jailUid === 'number');

  expect(ctx.fake.boots.map((boot) => boot.hostname)).toStrictEqual(['once', 'first']);
  expect(ctx.fake.restorePlans).toHaveLength(1);

  expect(ctx.fake.restorePlans[0]).toMatchObject({
    jail: { uid: second.jailUid, gid: second.jailUid },
    vmstate: join(directory, key, 'vmstate'),
    memFile: join(directory, key, 'mem'),
    systemDrivePath: ctx.readIdentity().systemDrivePath,
    placeholderPath: join(directory, 'placeholder.ext4'),
    cgroup: { procsPath: `/sys/fs/cgroup/imps/${second.id}/cgroup.procs` },
  });
});

test('it starts a jailed restore only once the clone is in place', async () => {
  const ctx = await setupTest({ isJailed: true });

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'first', vcpus: 1, memoryMib: 256 });
  await ctx.templates.buildTemplate({ vcpus: 1, memoryMib: 256 });

  const clone = ctx.disk.holdClone();

  const creating = ctx.client.imps.create({
    name: 'second',
    vcpus: 1,
    memoryMib: 256,
    diskMib: 2048,
  });

  await clone.reached;

  const restoresDuringClone = ctx.fake.restorePlans.length;

  clone.release();

  await creating;

  expect(restoresDuringClone).toBe(0);
  expect(ctx.fake.restores.map((restore) => restore.hostname)).toStrictEqual(['second']);
});

test('it overlaps a jailed restore with the grow of its disk', async () => {
  const ctx = await setupTest({ isJailed: true });

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'first', vcpus: 1, memoryMib: 256 });
  await ctx.templates.buildTemplate({ vcpus: 1, memoryMib: 256 });

  const grow = ctx.disk.holdGrow();

  const creating = ctx.client.imps.create({
    name: 'second',
    vcpus: 1,
    memoryMib: 256,
    diskMib: 2048,
  });

  await grow.reached;

  await waitFor(() => {
    expect(ctx.fake.restorePlans).toHaveLength(1);
  });

  grow.release();

  const second = await creating;

  expect(second.state).toBe('running');
  expect(ctx.fake.restores.map((restore) => restore.hostname)).toStrictEqual(['second']);
});

test('it restores a boot template for a create while four wakes hold every wake slot', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'once', vcpus: 1, memoryMib: 256 });
  await ctx.client.imps.create({ name: 'first', vcpus: 1, memoryMib: 256 });
  await ctx.templates.stop();

  const sleepers = ['a', 'b', 'c', 'd'];

  await Promise.all(
    sleepers.map((name) => ctx.client.imps.create({ name, vcpus: 1, memoryMib: 256 })),
  );

  await Promise.all(sleepers.map((name) => ctx.client.imps.sleep({ name })));

  ctx.fake.queue('wake', 'hang', 'hang', 'hang', 'hang');

  const wakes = sleepers.map((name) => waitForOutcome(ctx.client.imps.wake({ name }), 10_000));

  await waitFor(() => {
    expect(ctx.fake.countHungCalls()).toBe(4);
  });

  const restoresBefore = ctx.fake.restorePlans.length;

  const created = await waitForOutcome(
    ctx.client.imps.create({ name: 'fresh', vcpus: 1, memoryMib: 256 }),
    5000,
  );

  const restored = ctx.fake.restorePlans.length - restoresBefore;

  ctx.fake.releaseHangs();

  const woke = await Promise.all(wakes);

  expect(created).toBe('done');
  expect(restored).toBe(1);
  expect(woke).toStrictEqual(['done', 'done', 'done', 'done']);
});

test('it boots four imps whose wakes failed from a boot template while they hold every wake slot', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'once', vcpus: 1, memoryMib: 256 });
  await ctx.client.imps.create({ name: 'first', vcpus: 1, memoryMib: 256 });
  await ctx.templates.stop();

  const sleepers = ['a', 'b', 'c', 'd'];

  await Promise.all(
    sleepers.map((name) => ctx.client.imps.create({ name, vcpus: 1, memoryMib: 256 })),
  );

  await Promise.all(sleepers.map((name) => ctx.client.imps.sleep({ name })));

  const restoresBefore = ctx.fake.restorePlans.length;

  ctx.fake.queue('wake', 'fail', 'fail', 'fail', 'fail');

  const woke = await Promise.all(
    sleepers.map((name) => waitForOutcome(ctx.client.imps.wake({ name }), 5000)),
  );

  expect(woke).toStrictEqual(['done', 'done', 'done', 'done']);
  expect(ctx.fake.restorePlans.length - restoresBefore).toBe(4);
});

test('it restores at most four boot templates at once, and starts a fifth once one ends', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'once', vcpus: 1, memoryMib: 256 });
  await ctx.client.imps.create({ name: 'first', vcpus: 1, memoryMib: 256 });
  await ctx.templates.stop();

  ctx.fake.queue('restore', 'hang', 'hang', 'hang', 'hang', 'hang');

  const names = ['a', 'b', 'c', 'd', 'e'];

  const creates = names.map((name) =>
    waitForOutcome(ctx.client.imps.create({ name, vcpus: 1, memoryMib: 256 }), 10_000),
  );

  await waitFor(async () => {
    expect(ctx.fake.countHungCalls()).toBe(4);

    const listed = await listImps(ctx.db);

    expect(listed.map((imp) => imp.name)).toIncludeAllMembers(names);
  });

  const heldRestores = ctx.fake.restorePlans.length;

  ctx.fake.releaseHangs();

  await waitFor(() => {
    expect(ctx.fake.countHungCalls()).toBe(1);
  });

  ctx.fake.releaseHangs();

  const created = await Promise.all(creates);

  expect(heldRestores).toBe(4);
  expect(created).toStrictEqual(['done', 'done', 'done', 'done', 'done']);
});
