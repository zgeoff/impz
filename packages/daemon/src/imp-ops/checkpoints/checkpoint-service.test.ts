import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Imp } from '@impz/api';
import invariant from 'tiny-invariant';
import { buildMockNewCheckpoint } from '../../../testing/imp-ops/build-mock-new-checkpoint';
import { buildMockNewImage } from '../../../testing/imps/build-mock-new-image';
import { buildMockNewImp } from '../../../testing/imps/build-mock-new-imp';
import { buildQueryGate } from '../../../testing/platform/build-query-gate';
import { startTestImpd } from '../../../testing/start-test-impd';
import { buildStubZfs } from '../../../testing/vm/build-stub-zfs';
import { createCheckpoint, listCheckpoints } from '../../platform/db/checkpoints';
import { createImage } from '../../platform/db/images';
import { createImp, readImpByName } from '../../platform/db/imps';
import type { ImpRecord } from '../../platform/db/imps';
import { buildImagePaths, buildImpPaths } from '../../vm/storage/data-layout';
import { CheckpointIdTakenError } from '../../vm/storage/storage-backend';
import { createXfsBackend } from '../../vm/storage/xfs-backend';
import { createZfsBackend } from '../../vm/storage/zfs/zfs-backend';
import {
  buildCheckpointId,
  createCheckpointService,
  isValidCheckpointLabel,
} from './checkpoint-service';

interface SetupOptions {
  readonly storage: 'xfs' | 'zfs';
}

async function setupTest(options: SetupOptions) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'checkpoint-service-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const events: string[] = [];
  const zfs = buildStubZfs({ root: 'tank/imp', rootDir: dataDir });

  const storages = {
    xfs: () =>
      createXfsBackend({
        dataDir,
        cloneFile: (source, target) => {
          events.push(`clone ${source.slice(dataDir.length)}`);

          return copyFile(source, target);
        },
      }),

    zfs: () =>
      createZfsBackend({
        dataDir,
        root: 'tank/imp',
        run: zfs.run,
        streams: zfs.streams,
        readMounts: zfs.readMounts,
        readModuleVersion: () => '2.4.4',
      }),
  };

  const freezer = {
    freeze: () => {
      events.push('freeze');

      return Promise.resolve();
    },
    thaw: () => {
      events.push('thaw');

      return Promise.resolve();
    },
  };

  const gate = buildQueryGate('base');

  const harness = await startTestImpd(stack, {
    dataDir,
    wrapDatabase: gate.wrap,
    createStorage: storages[options.storage],
    boundaries: { freezer },
  });

  return Object.assign(harness, { events, gate });
}

test('it makes an id of cp- and six letters that read unambiguously', () => {
  expect(buildCheckpointId()).toMatch(/^cp-[a-km-z2-9]{6}$/u);
});

test('it picks each letter of an id from its own draw of the random source', () => {
  const draws = [0, 10 / 32, 11 / 32, 23 / 32, 24 / 32, 31 / 32];

  expect(buildCheckpointId(() => draws.shift() ?? Number.NaN)).toBe('cp-akmz29');
});

test.each([
  ['cp-abc', false],
  ['clean', true],
])('it judges the label %s valid: %p', (label, isValid) => {
  expect(isValidCheckpointLabel(label)).toBe(isValid);
});

test('it freezes a running imp around the clone and records the checkpoint', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, buildMockNewImage({ name: 'base', digest: 'sha256:base' }));

  const imp = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  const seen = ctx.events.length;

  const checkpoint = await ctx.impd.checkpoints.createCheckpoint('dev', 'clean');

  const disk = join(buildImpPaths(ctx.dataDir, imp.id).checkpointsDir, checkpoint.id, 'disk.ext4');

  const listed = await ctx.impd.checkpoints.listCheckpoints('dev');

  expect(ctx.events.slice(seen)).toStrictEqual([
    'freeze',
    `clone /imps/${imp.id}/disk.ext4`,
    'thaw',
  ]);

  expect(checkpoint).toMatchObject({ label: 'clean' });
  expect(readFileSync(disk, 'utf8')).toBe('rootfs');
  expect(listed).toStrictEqual([checkpoint]);
});

test('it clones a stopped imp without freezing it', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, buildMockNewImage({ name: 'base', digest: 'sha256:base' }));

  const imp = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  await ctx.impd.imps.stopImp('dev');

  const seen = ctx.events.length;

  const checkpoint = await ctx.impd.checkpoints.createCheckpoint('dev', undefined);

  expect(ctx.events.slice(seen)).toStrictEqual([`clone /imps/${imp.id}/disk.ext4`]);
  expect(checkpoint.label).toBeUndefined();
});

test('it thaws and leaves no checkpoint when the clone fails', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, buildMockNewImage({ name: 'base', digest: 'sha256:base' }));

  const imp = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);

  rmSync(paths.disk);

  const seen = ctx.events.length;

  expect(ctx.impd.checkpoints.createCheckpoint('dev', undefined)).rejects.toMatchObject({
    code: 'ENOENT',
  });

  const rows = await listCheckpoints(ctx.db, imp.id);

  expect(ctx.events.slice(seen)).toStrictEqual([
    'freeze',
    `clone /imps/${imp.id}/disk.ext4`,
    'thaw',
  ]);

  expect(rows).toStrictEqual([]);
  expect(readdirSync(paths.checkpointsDir)).toStrictEqual([]);
});

test('it rejects a label another checkpoint of the imp holds', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, buildMockNewImage({ name: 'base', digest: 'sha256:base' }));

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });
  await ctx.impd.checkpoints.createCheckpoint('dev', 'clean');

  expect(ctx.impd.checkpoints.createCheckpoint('dev', 'clean')).rejects.toMatchObject({
    code: 'CONFLICT',
    data: { kind: 'checkpoint', name: 'clean' },
  });
});

test('it rejects a label shaped like a checkpoint id', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, buildMockNewImage({ name: 'base', digest: 'sha256:base' }));

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  expect(ctx.impd.checkpoints.createCheckpoint('dev', 'cp-abc')).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'a label must not start with cp-',
  });
});

test('it restores a running imp: kill, swap the disk, drop the snapshot, boot', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, buildMockNewImage({ name: 'base', digest: 'sha256:base' }));

  const imp = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);

  writeFileSync(paths.disk, 'a=1');

  await ctx.impd.checkpoints.createCheckpoint('dev', 'v1');

  writeFileSync(paths.disk, 'a=2');
  mkdirSync(paths.snapshotDir, { recursive: true });
  writeFileSync(join(paths.snapshotDir, 'memory'), 'old');

  const restored = await ctx.impd.checkpoints.restoreCheckpoint('dev', 'v1');
  const record = await readImpByName(ctx.db, 'dev');

  expect(restored.state).toBe('running');
  expect(ctx.fake.stops).toStrictEqual([{ pid: 1001, graceful: false }]);
  expect(readFileSync(paths.disk, 'utf8')).toBe('a=1');
  expect(existsSync(paths.snapshotDir)).toBe(false);
  expect(existsSync(`${paths.disk}.new`)).toBe(false);
  expect(record?.pid).toBe(1002);
});

test('it restores a stopped imp and leaves it stopped', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, buildMockNewImage({ name: 'base', digest: 'sha256:base' }));

  const imp = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });
  const checkpoint = await ctx.impd.checkpoints.createCheckpoint('dev', undefined);

  const disk = buildImpPaths(ctx.dataDir, imp.id).disk;

  await ctx.impd.imps.stopImp('dev');

  writeFileSync(disk, 'changed');

  const restored = await ctx.impd.checkpoints.restoreCheckpoint('dev', checkpoint.id);

  expect(restored.state).toBe('stopped');
  expect(readFileSync(disk, 'utf8')).toBe('rootfs');
});

test('it forks a checkpoint into a new slot with its source’s shape', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, buildMockNewImage({ name: 'base', digest: 'sha256:base' }));

  const source = await ctx.impd.imps.createImp({
    name: 'dev',
    image: 'base',
    vcpus: 3,
    memoryMib: 1024,
  });

  const sourceDisk = buildImpPaths(ctx.dataDir, source.id).disk;

  writeFileSync(sourceDisk, 'a=1');

  await ctx.impd.checkpoints.createCheckpoint('dev', 'v1');

  writeFileSync(sourceDisk, 'a=2');

  const forked = await ctx.impd.checkpoints.forkImp({
    source: 'dev',
    name: 'old',
    checkpoint: 'v1',
  });

  expect(forked).toMatchObject({
    imp: { name: 'old', state: 'running', vcpus: 3, memoryMib: 1024, slot: 1 },
    sourceId: source.id,
  });

  expect(readFileSync(buildImpPaths(ctx.dataDir, forked.imp.id).disk, 'utf8')).toBe('a=1');
});

test('it forks the live disk, frozen, into a new imp with no checkpoints', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, buildMockNewImage({ name: 'base', digest: 'sha256:base' }));

  const source = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  await ctx.impd.checkpoints.createCheckpoint('dev', 'v1');

  writeFileSync(buildImpPaths(ctx.dataDir, source.id).disk, 'a=2');

  const seen = ctx.events.length;

  const forked = await ctx.impd.checkpoints.forkImp({ source: 'dev', name: 'now' });
  const forkCheckpoints = await ctx.impd.checkpoints.listCheckpoints('now');

  expect(ctx.events.slice(seen, seen + 3)).toStrictEqual([
    'freeze',
    `clone /imps/${source.id}/disk.ext4`,
    'thaw',
  ]);

  expect(forked).toMatchObject({ imp: { name: 'now', state: 'running', image: 'base', slot: 1 } });
  expect(readFileSync(buildImpPaths(ctx.dataDir, forked.imp.id).disk, 'utf8')).toBe('a=2');
  expect(forkCheckpoints).toStrictEqual([]);
});

test('it keeps a fork of an imp created with backup off out of backups too', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, buildMockNewImage({ name: 'base', digest: 'sha256:base' }));

  await ctx.impd.imps.createImp({ name: 'chat', image: 'base', isBackedUp: false });

  const forked = await ctx.impd.checkpoints.forkImp({ source: 'chat', name: 'copy' });
  const fork = await readImpByName(ctx.db, 'copy');

  expect(forked.imp.backup).toBe(false);
  expect(fork?.isBackedUp).toBe(false);
});

test('it creates no imp when the fork’s checkpoint is unknown', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, buildMockNewImage({ name: 'base', digest: 'sha256:base' }));

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  expect(
    ctx.impd.checkpoints.forkImp({ source: 'dev', name: 'copy', checkpoint: 'nope' }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND', data: { kind: 'checkpoint', name: 'nope' } });

  const copy = await readImpByName(ctx.db, 'copy');

  expect(copy).toBeUndefined();
});

test('it creates no imp when the fork’s source is unknown', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  expect(ctx.impd.checkpoints.forkImp({ source: 'gone', name: 'copy' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'imp', name: 'gone' },
  });

  const copy = await readImpByName(ctx.db, 'copy');

  expect(copy).toBeUndefined();
});

test('it deletes a checkpoint by its label and keeps the others', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, buildMockNewImage({ name: 'base', digest: 'sha256:base' }));

  const imp = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });
  const first = await ctx.impd.checkpoints.createCheckpoint('dev', 'one');
  const second = await ctx.impd.checkpoints.createCheckpoint('dev', 'two');

  await ctx.impd.checkpoints.removeCheckpoint('dev', 'one');

  const checkpointsDir = buildImpPaths(ctx.dataDir, imp.id).checkpointsDir;

  const remaining = await ctx.impd.checkpoints.listCheckpoints('dev');

  expect(existsSync(join(checkpointsDir, first.id))).toBe(false);
  expect(remaining).toStrictEqual([second]);
});

test('it removes an imp’s checkpoints with the imp', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, buildMockNewImage({ name: 'base', digest: 'sha256:base' }));

  const imp = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  await ctx.impd.checkpoints.createCheckpoint('dev', 'one');
  await ctx.impd.imps.destroyImp('dev');

  const rows = await listCheckpoints(ctx.db, imp.id);

  expect(existsSync(buildImpPaths(ctx.dataDir, imp.id).directory)).toBe(false);
  expect(rows).toStrictEqual([]);
});

test('it rejects a listing of an imp that does not exist', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  expect(ctx.impd.checkpoints.listCheckpoints('gone')).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'imp', name: 'gone' },
  });
});

test('it rejects a restore of an imp still being created', async () => {
  const ctx = await setupTest({ storage: 'xfs' });
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ name: 'dev', imageId: image.id }));

  await createCheckpoint(ctx.db, buildMockNewCheckpoint({ impId: imp.id, label: 'v1' }));

  expect(ctx.impd.checkpoints.restoreCheckpoint('dev', 'v1')).rejects.toMatchObject({
    code: 'INVALID_STATE',
  });
});

test('it rejects a fork of the live disk of an imp still being created', async () => {
  const ctx = await setupTest({ storage: 'xfs' });
  const image = await createImage(ctx.db, buildMockNewImage());

  await createImp(ctx.db, buildMockNewImp({ name: 'dev', imageId: image.id }));

  expect(ctx.impd.checkpoints.forkImp({ source: 'dev', name: 'copy' })).rejects.toMatchObject({
    code: 'INVALID_STATE',
  });

  const copy = await readImpByName(ctx.db, 'copy');

  expect(copy).toBeUndefined();
});

test('it leaves a sleeping imp asleep with its memory when a restore’s clone fails', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, buildMockNewImage({ name: 'base', digest: 'sha256:base' }));

  const imp = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);

  const checkpoint = await ctx.impd.checkpoints.createCheckpoint('dev', 'v1');

  await ctx.impd.imps.sleepImp('dev');

  rmSync(join(paths.checkpointsDir, checkpoint.id, 'disk.ext4'));

  const restore = ctx.impd.checkpoints.restoreCheckpoint('dev', 'v1');

  expect(restore).rejects.toMatchObject({ code: 'ENOENT' });

  const record = await readImpByName(ctx.db, 'dev');

  expect(record?.state).toBe('sleeping');
  expect(existsSync(paths.memFile)).toBe(true);
  expect(existsSync(`${paths.disk}.new`)).toBe(false);
});

test('it leaves a running imp running on its own disk when a restore’s clone fails', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, buildMockNewImage({ name: 'base', digest: 'sha256:base' }));

  const imp = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);

  const checkpoint = await ctx.impd.checkpoints.createCheckpoint('dev', 'v1');

  writeFileSync(paths.disk, 'changed');
  rmSync(join(paths.checkpointsDir, checkpoint.id, 'disk.ext4'));

  expect(ctx.impd.checkpoints.restoreCheckpoint('dev', 'v1')).rejects.toMatchObject({
    code: 'ENOENT',
  });

  const record = await readImpByName(ctx.db, 'dev');

  expect(record).toMatchObject({ state: 'running', pid: 1001 });
  expect(ctx.fake.stops).toStrictEqual([]);
  expect(readFileSync(paths.disk, 'utf8')).toBe('changed');
});

test('it leaves the imp stopped on its old disk when a restore’s swap fails after the kill', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, buildMockNewImage({ name: 'base', digest: 'sha256:base' }));

  const imp = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);

  await ctx.impd.checkpoints.createCheckpoint('dev', 'v1');

  writeFileSync(paths.disk, 'changed');
  mkdirSync(paths.snapshotDir, { recursive: true });
  writeFileSync(join(paths.snapshotDir, 'memory'), 'old');

  const kill = ctx.fake.hold('stop');
  const restore = ctx.impd.checkpoints.restoreCheckpoint('dev', 'v1');

  await kill.reached;

  rmSync(`${paths.disk}.new`);

  kill.release();

  expect(restore).rejects.toMatchObject({ code: 'ENOENT' });

  const record = await readImpByName(ctx.db, 'dev');

  expect(ctx.fake.stops).toStrictEqual([{ pid: 1001, graceful: false }]);
  expect(record).toMatchObject({ state: 'stopped', pid: null });
  expect(existsSync(paths.snapshotDir)).toBe(false);
  expect(readFileSync(paths.disk, 'utf8')).toBe('changed');
});

test('it refuses a fork whose source is destroyed before the disk copy and leaves nothing', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, buildMockNewImage({ name: 'base', digest: 'sha256:base' }));

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  ctx.gate.arm();

  const fork = ctx.impd.checkpoints.forkImp({ source: 'dev', name: 'copy' });

  await ctx.gate.reached;

  await ctx.impd.imps.destroyImp('dev');

  ctx.gate.release();

  expect(fork).rejects.toMatchObject({
    code: 'CONFLICT',
    message: 'imp dev changed during the fork; the fork was not made',
  });

  const imps = await ctx.impd.imps.listImps();

  expect(imps).toStrictEqual([]);
  expect(readdirSync(join(ctx.dataDir, 'imps'))).toStrictEqual([]);
});

test('it refuses a fork whose source is made again under its name before the disk copy', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, buildMockNewImage({ name: 'base', digest: 'sha256:base' }));

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  ctx.gate.arm();

  const fork = ctx.impd.checkpoints.forkImp({ source: 'dev', name: 'copy' });

  await ctx.gate.reached;

  await ctx.impd.imps.destroyImp('dev');

  const remade = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  ctx.gate.release();

  expect(fork).rejects.toMatchObject({
    code: 'CONFLICT',
    message: 'imp dev changed during the fork; the fork was not made',
  });

  const imps = await ctx.impd.imps.listImps();

  expect(imps).toMatchObject([{ id: remade.id, name: 'dev' }]);
  expect(readdirSync(join(ctx.dataDir, 'imps'))).toStrictEqual([remade.id]);
});

test('it leaves an imp that took a refused fork’s name before the fork’s cleanup', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  const image = await createImage(
    ctx.db,
    buildMockNewImage({ name: 'base', digest: 'sha256:base' }),
  );

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  ctx.gate.arm();

  const fork = ctx.impd.checkpoints.forkImp({ source: 'dev', name: 'copy' });

  await ctx.gate.reached;

  await ctx.impd.imps.destroyImp('dev');
  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  const queued: { row?: ImpRecord; removed?: Promise<void>; taker?: Promise<Imp> } = {};

  const unwatch = ctx.db.writes.subscribe((write) => {
    unwatch();

    if (write.kind !== 'added') {
      throw new Error(`the first write was ${write.kind}, not the fork's row`);
    }

    queued.row = write.imp;
    queued.removed = ctx.impd.imps.destroyImpId(write.imp.id);

    queued.taker = ctx.impd.imps.lockImpId(write.imp.id, () =>
      ctx.impd.imps.createImp({ name: 'copy', image: image.name }),
    );
  });

  onTestFinished(unwatch);

  ctx.gate.release();

  expect(fork).rejects.toMatchObject({ code: 'CONFLICT' });

  invariant(queued.row);
  invariant(queued.removed);
  invariant(queued.taker);

  await queued.removed;

  const taker = await queued.taker;
  const copy = await readImpByName(ctx.db, 'copy');
  const imps = await ctx.impd.imps.listImps();

  expect(queued.row.name).toBe('copy');
  expect(taker.id).not.toBe(queued.row.id);
  expect(copy?.id).toBe(taker.id);
  expect(imps.map((imp) => imp.name).toSorted()).toStrictEqual(['copy', 'dev']);
});

test('it draws a new id when the pool holds a snapshot by the drawn one', async () => {
  const ctx = await setupTest({ storage: 'zfs' });

  await ctx.storage.createImage('sha256:base', () => Promise.resolve());

  writeFileSync(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(ctx.db, buildMockNewImage({ name: 'base', digest: 'sha256:base' }));

  const impId = '01890000-0000-7000-8000-000000000001';
  const disk = ctx.storage.resolveImpPaths(impId).disk;

  mkdirSync(dirname(disk), { recursive: true });
  writeFileSync(disk, 'rootfs');

  await ctx.impd.imps.createImp({ id: impId, name: 'dev', image: 'base' });

  const draws = [
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    1 / 32,
    1 / 32,
    1 / 32,
    1 / 32,
    1 / 32,
    1 / 32,
  ];

  const checkpoints = createCheckpointService({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    storage: ctx.storage,
    diskBudget: ctx.impd.diskBudget,

    freezer: { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() },
    random: () => draws.shift() ?? Number.NaN,
  });

  await checkpoints.createCheckpoint('dev', 'first');

  const second = await checkpoints.createCheckpoint('dev', 'second');

  expect(second.id).toBe('cp-bbbbbb');
});

test('it draws a new id when a deleted checkpoint’s snapshot stays for a fork', async () => {
  const ctx = await setupTest({ storage: 'zfs' });

  await ctx.storage.createImage('sha256:base', () => Promise.resolve());

  writeFileSync(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(ctx.db, buildMockNewImage({ name: 'base', digest: 'sha256:base' }));

  const impId = '01890000-0000-7000-8000-000000000001';
  const disk = ctx.storage.resolveImpPaths(impId).disk;

  mkdirSync(dirname(disk), { recursive: true });
  writeFileSync(disk, 'rootfs');

  await ctx.impd.imps.createImp({ id: impId, name: 'dev', image: 'base' });

  const draws = [
    ...Array.from({ length: 12 }, () => 0),
    ...Array.from({ length: 6 }, () => 1 / 32),
  ];

  const checkpoints = createCheckpointService({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    storage: ctx.storage,
    diskBudget: ctx.impd.diskBudget,

    freezer: { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() },
    random: () => draws.shift() ?? Number.NaN,
  });

  await checkpoints.createCheckpoint('dev', 'v1');

  const unwatch = ctx.db.writes.subscribe((write) => {
    unwatch();

    if (write.kind !== 'added') {
      throw new Error(`the first write was ${write.kind}, not the fork's row`);
    }

    const forkDisk = ctx.storage.resolveImpPaths(write.imp.id).disk;

    mkdirSync(dirname(forkDisk), { recursive: true });
    writeFileSync(forkDisk, 'rootfs');
  });

  onTestFinished(unwatch);

  await checkpoints.forkImp({ source: 'dev', name: 'copy', checkpoint: 'v1' });
  await checkpoints.removeCheckpoint('dev', 'v1');

  const created = await checkpoints.createCheckpoint('dev', 'v2');

  expect(created.id).toBe('cp-bbbbbb');
});

test('it gives up after three drawn ids that each name a snapshot in the pool', async () => {
  const ctx = await setupTest({ storage: 'zfs' });

  await ctx.storage.createImage('sha256:base', () => Promise.resolve());

  writeFileSync(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(ctx.db, buildMockNewImage({ name: 'base', digest: 'sha256:base' }));

  const impId = '01890000-0000-7000-8000-000000000001';
  const disk = ctx.storage.resolveImpPaths(impId).disk;

  mkdirSync(dirname(disk), { recursive: true });
  writeFileSync(disk, 'rootfs');

  await ctx.impd.imps.createImp({ id: impId, name: 'dev', image: 'base' });

  const draws = [
    ...Array.from({ length: 24 }, () => 0),
    ...Array.from({ length: 6 }, () => 1 / 32),
  ];

  const checkpoints = createCheckpointService({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    storage: ctx.storage,
    diskBudget: ctx.impd.diskBudget,

    freezer: { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() },
    random: () => draws.shift() ?? Number.NaN,
  });

  await checkpoints.createCheckpoint('dev', 'first');

  expect(checkpoints.createCheckpoint('dev', 'second')).rejects.toBeInstanceOf(
    CheckpointIdTakenError,
  );

  const listed = await checkpoints.listCheckpoints('dev');

  expect(listed).toMatchObject([{ id: 'cp-aaaaaa', label: 'first' }]);
});
