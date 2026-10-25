import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readImpEnv } from '@impz/test-utils/read-imp-env';
import { updateEnv } from '@impz/test-utils/update-env';
import invariant from 'tiny-invariant';
import { buildMockBackupConfig } from '../../../testing/imp-ops/build-mock-backup-config';
import { buildMockNewCheckpoint } from '../../../testing/imp-ops/build-mock-new-checkpoint';
import { buildStubRestic } from '../../../testing/imp-ops/build-stub-restic';
import { buildQueryGate } from '../../../testing/platform/build-query-gate';
import { captureImpdLogs } from '../../../testing/platform/capture-impd-logs';
import { runSql } from '../../../testing/platform/run-sql';
import { startTestImpd } from '../../../testing/start-test-impd';
import { buildStubPressureSwitch } from '../../../testing/vm/build-stub-pressure-switch';
import { buildStubPublishHook } from '../../../testing/vm/build-stub-publish-hook';
import { createTemplateService } from '../../imps/images/template-service';
import { createNetworkService } from '../../network/networks/network-service';
import { createCheckpoint, listCheckpoints } from '../../platform/db/checkpoints';
import { readImageByName } from '../../platform/db/images';
import { readImpByName } from '../../platform/db/imps';
import { readSecret } from '../../platform/db/secrets';
import { updateImpState } from '../../platform/db/update-imp-state';
import { BACKUP_TREE, buildImagePaths, buildImpPaths } from '../../vm/storage/data-layout';
import { writeImageFiles } from '../../vm/storage/write-image-files';
import { createXfsBackend } from '../../vm/storage/xfs-backend';
import { BackupManifestSchema } from './backup-manifest';
import { buildBackupsOffError, createBackupService } from './backup-service';
import type { BackupServiceDeps } from './backup-service';
import { ResticError } from './restic';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const repoDir = mkdtempSync(join(tmpdir(), 'impd-restic-test-'));

  stack.defer(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  const publish = buildStubPublishHook();
  const pressure = buildStubPressureSwitch();

  const host = await startTestImpd(stack, {
    frozenClockMs: Date.UTC(2026, 9, 2),
    createStorage: (dataDir) =>
      publish.wrap(
        pressure.wrap(
          createXfsBackend({ dataDir, cloneFile: (source, target) => copyFile(source, target) }),
        ),
      ),
    env: readImpEnv(),
  });

  const restic = buildStubRestic({ repoDir, now: () => new Date(host.now()) });
  const freezes: string[] = [];
  const backupLogs = captureImpdLogs();

  const deps: Omit<BackupServiceDeps, 'backup'> = {
    dataDir: host.dataDir,
    db: host.db,
    imps: host.imps,
    grants: host.broker,
    tokens: host.tokens,
    networks: createNetworkService({ db: host.db, egress: host.egress, imps: host.imps }),
    storage: host.storage,
    images: host.images,
    storageGate: host.storageGate,
    diskBudget: host.diskBudget,
    writeImageFiles,
    restic: restic.restic,
    now: () => new Date(host.now()),
    freezer: {
      freeze: () => {
        freezes.push('freeze');

        return Promise.resolve();
      },
      thaw: () => {
        freezes.push('thaw');

        return Promise.resolve();
      },
    },
  };

  return Object.assign(host, {
    stack,
    repoDir,
    restic,
    freezes,
    backupLogs,
    deps,
    publish,
    pressure,
  });
}

test('#runBackup freezes a running imp and copies stopped and sleeping imps as they are', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await ctx.imps.createImp({ name: 'idle' });
  await ctx.imps.stopImp('idle');
  await ctx.imps.createImp({ name: 'napping' });
  await ctx.imps.sleepImp('napping');

  const run = await backups.runBackup();

  const manifestText = readFileSync(join(ctx.repoDir, run.snapshotId, 'manifest.json'), 'utf8');
  const manifest = BackupManifestSchema.parse(JSON.parse(manifestText));

  expect(ctx.freezes).toStrictEqual(['freeze', 'thaw']);
  expect(run.imps).toStrictEqual(['dev', 'idle', 'napping']);
  expect(run.skipped).toStrictEqual([]);

  expect(manifest.imps.map((imp) => [imp.name, imp.state, imp.synced])).toStrictEqual([
    ['dev', 'running', true],
    ['idle', 'stopped', true],
    ['napping', 'sleeping', false],
  ]);
});

test('#runBackup copies a running imp unsynced when its freeze fails, and logs the freeze', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig(),
    freezer: {
      freeze: () => Promise.reject(new Error('the agent did not answer')),
      thaw: () => Promise.resolve(),
    },
  });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });

  const lines = captureImpdLogs();

  const run = await backups.runBackup();

  const manifestText = readFileSync(join(ctx.repoDir, run.snapshotId, 'manifest.json'), 'utf8');
  const manifest = BackupManifestSchema.parse(JSON.parse(manifestText));

  expect(manifest.imps.map((imp) => [imp.name, imp.synced])).toStrictEqual([['dev', false]]);

  expect(lines).toContain(
    'WARNING impd.backup imp=dev no freeze, copied unsynced: the agent did not answer',
  );
});

test('#runBackup keeps a synced copy of a running imp whose thaw fails, and logs the thaw', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig(),
    freezer: {
      freeze: () => Promise.resolve(),
      thaw: () => Promise.reject(new Error('the agent did not answer')),
    },
  });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });

  const lines = captureImpdLogs();

  const run = await backups.runBackup();

  const manifestText = readFileSync(join(ctx.repoDir, run.snapshotId, 'manifest.json'), 'utf8');
  const manifest = BackupManifestSchema.parse(JSON.parse(manifestText));

  expect(manifest.imps.map((imp) => [imp.name, imp.synced])).toStrictEqual([['dev', true]]);

  expect(lines).toContain(
    'WARNING impd.backup imp=dev thaw failed (the agent thaws on its own): the agent did not answer',
  );
});

test('#runBackup tags the snapshot with the run and each imp, then forgets', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await ctx.imps.createImp({ name: 'idle' });
  await backups.runBackup();

  const [snapshot] = ctx.restic.readSnapshots();

  expect(snapshot?.tags).toStrictEqual([
    'imp-backup',
    expect.stringMatching(/^run=/v),
    'imp=dev',
    'imp=idle',
  ]);

  expect(ctx.restic.calls).toStrictEqual(['unlock', 'backup', 'forget']);
});

test('#runBackup records each imp’s settings, checkpoints and image in the manifest', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  const dev = await ctx.imps.createImp({ name: 'dev', httpPort: 3000, memoryMib: 256 });
  const oneBytes = await ctx.storage.createCheckpoint(dev.id, 'cp-one');

  await createCheckpoint(
    ctx.db,
    buildMockNewCheckpoint({
      id: 'cp-one',
      impId: dev.id,
      label: 'one',
      sizeBytes: oneBytes,
      createdAt: new Date('2026-09-01T00:00:00Z'),
    }),
  );

  const twoBytes = await ctx.storage.createCheckpoint(dev.id, 'cp-two');

  await createCheckpoint(
    ctx.db,
    buildMockNewCheckpoint({
      id: 'cp-two',
      impId: dev.id,
      label: 'two',
      sizeBytes: twoBytes,
      createdAt: new Date('2026-09-02T00:00:00Z'),
    }),
  );

  const run = await backups.runBackup();

  const manifestText = readFileSync(join(ctx.repoDir, run.snapshotId, 'manifest.json'), 'utf8');
  const manifest = BackupManifestSchema.parse(JSON.parse(manifestText));
  const [recorded] = manifest.imps;

  expect(recorded).toMatchObject({
    name: 'dev',
    httpPort: 3000,
    memoryMib: 256,
    imageDigest: 'sha256:base',
  });

  expect(recorded?.checkpoints.map((checkpoint) => checkpoint.label)).toStrictEqual(['one', 'two']);
  expect(manifest.images.map((image) => image.digest)).toStrictEqual(['sha256:base']);
});

test('#runBackup keeps the database copy and the token out of the snapshot', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });

  const run = await backups.runBackup();

  const snapshotDir = join(ctx.repoDir, run.snapshotId);

  expect(readdirSync(snapshotDir)).toIncludeSameMembers(['images', 'imps', 'manifest.json']);
  expect(readFileSync(join(snapshotDir, 'manifest.json'), 'utf8')).not.toContain('token');
});

test('#restoreBackup restores an imp stopped, with its disk and its checkpoints newest first', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  const dev = await ctx.imps.createImp({ name: 'dev', httpPort: 3000, memoryMib: 256 });

  const devDisk = buildImpPaths(ctx.dataDir, dev.id).disk;

  writeFileSync(devDisk, 'one');

  const oneBytes = await ctx.storage.createCheckpoint(dev.id, 'cp-one');

  await createCheckpoint(
    ctx.db,
    buildMockNewCheckpoint({
      id: 'cp-one',
      impId: dev.id,
      label: 'one',
      sizeBytes: oneBytes,
      createdAt: new Date('2026-09-01T00:00:00Z'),
      diskBytes: 1003,
    }),
  );

  writeFileSync(devDisk, 'two');

  const twoBytes = await ctx.storage.createCheckpoint(dev.id, 'cp-two');

  await createCheckpoint(
    ctx.db,
    buildMockNewCheckpoint({
      id: 'cp-two',
      impId: dev.id,
      label: 'two',
      sizeBytes: twoBytes,
      createdAt: new Date('2026-09-02T00:00:00Z'),
      diskBytes: 1003,
    }),
  );

  writeFileSync(devDisk, 'now');

  await backups.runBackup();
  await ctx.imps.destroyImp('dev');

  const result = await backups.restoreBackup({ name: 'dev' });
  const restored = await readImpByName(ctx.db, 'dev');

  invariant(restored);

  const checkpoints = await listCheckpoints(ctx.db, restored.id);

  const checkpointsDir = buildImpPaths(ctx.dataDir, restored.id).checkpointsDir;

  expect(result.imps).toStrictEqual([
    expect.objectContaining({ name: 'dev', state: 'stopped', httpPort: 3000, memoryMib: 256 }),
  ]);

  expect(readFileSync(buildImpPaths(ctx.dataDir, restored.id).disk, 'utf8')).toBe('now');

  expect(checkpoints).toStrictEqual([
    {
      id: expect.not.toBeOneOf(['cp-one', 'cp-two']),
      impId: restored.id,
      label: 'two',
      sizeBytes: expect.toBeNumber(),
      createdAt: new Date('2026-09-02T00:00:00Z'),
      diskBytes: 1003,
    },
    {
      id: expect.not.toBeOneOf(['cp-one', 'cp-two']),
      impId: restored.id,
      label: 'one',
      sizeBytes: expect.toBeNumber(),
      createdAt: new Date('2026-09-01T00:00:00Z'),
      diskBytes: 1003,
    },
  ]);

  expect(readFileSync(join(checkpointsDir, checkpoints[0]?.id ?? '', 'disk.ext4'), 'utf8')).toBe(
    'two',
  );

  expect(readFileSync(join(checkpointsDir, checkpoints[1]?.id ?? '', 'disk.ext4'), 'utf8')).toBe(
    'one',
  );

  expect(readdirSync(join(ctx.dataDir, 'backup', 'restore'))).toStrictEqual([]);
});

test('#restoreBackup keeps an old image it reuses when an eviction reaches the restore as it picks the image', async () => {
  updateEnv('IMP_IMAGE_EVICT_HIGH_PERCENT', '80');
  updateEnv('IMP_IMAGE_EVICT_LOW_PERCENT', '60');

  const ctx = await setupTest();

  ctx.setClock(Date.UTC(2026, 9, 2));

  const gate = buildQueryGate('sha256:web-1111111');

  ctx.stack.defer(() => {
    gate.release();
  });

  const backups = createBackupService({
    ...ctx.deps,
    db: gate.wrap(ctx.db),
    backup: buildMockBackupConfig(),
  });

  await ctx.createTestImage('web-1111111');

  writeFileSync(join(ctx.dataDir, 'images', 'web-1111111', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev', image: 'web-1111111' });
  await backups.runBackup();
  await ctx.imps.destroyImp('dev');

  await ctx.db
    .updateTable('images')
    .set({ last_used_at: Date.parse('2026-08-01T00:00:00Z') })
    .where('name', '=', 'web-1111111')
    .execute();

  ctx.pressure.setPressure({ usedBytes: 90, availableBytes: 10, freedBytes: 1 });
  gate.arm();

  const restoring = backups.restoreBackup({ name: 'dev' });

  await gate.reached;

  await ctx.images.runImageEviction();

  gate.release();

  await restoring;

  const image = await readImageByName(ctx.db, 'web-1111111');
  const dev = await readImpByName(ctx.db, 'dev');

  expect(image?.name).toBe('web-1111111');
  expect(dev?.imageId).toBe(image?.id);
});

test('#restoreBackup records its clock as the last use of an image row it writes', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('web-1111111');

  writeFileSync(join(ctx.dataDir, 'images', 'web-1111111', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev', image: 'web-1111111' });
  await backups.runBackup();
  await ctx.imps.destroyImp('dev');
  await ctx.images.removeImage('web-1111111');
  await backups.restoreBackup({ name: 'dev' });

  const row = await ctx.db
    .selectFrom('images')
    .select('last_used_at')
    .where('name', '=', 'web-1111111')
    .executeTakeFirstOrThrow();

  expect(row.last_used_at).toBe(ctx.now());
});

test('#restoreBackup keeps the rootfs it publishes when the cleanup of an earlier removal of its digest runs before its row', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('web-1111111');

  writeFileSync(join(ctx.dataDir, 'images', 'web-1111111', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev', image: 'web-1111111' });
  await backups.runBackup();
  await ctx.imps.destroyImp('dev');
  await ctx.images.removeImage('web-1111111');

  ctx.publish.setAfterPublish(async (digest) => {
    await ctx.db.insertInto('image_removals').values({ digest, created_at: 0 }).execute();
    await ctx.images.runImageEviction();
  });

  await backups.restoreBackup({ name: 'dev' });

  const image = await readImageByName(ctx.db, 'web-1111111');

  invariant(image);

  expect(existsSync(buildImagePaths(ctx.dataDir, image.digest).rootfs)).toBeTrue();
});

test('#restoreBackup restores the newest backup at or before --at that holds the imp', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  const dev = await ctx.imps.createImp({ name: 'dev' });

  writeFileSync(buildImpPaths(ctx.dataDir, dev.id).disk, 'early');

  await backups.runBackup();

  const halfway = ctx.now() + 30 * 60 * 1000;

  ctx.advance(60 * 60 * 1000);

  writeFileSync(buildImpPaths(ctx.dataDir, dev.id).disk, 'later');

  await backups.runBackup();

  ctx.advance(60 * 60 * 1000);

  await backups.restoreBackup({ name: 'dev', as: 'back', at: new Date(halfway) });

  const back = await readImpByName(ctx.db, 'back');

  invariant(back);

  expect(readFileSync(buildImpPaths(ctx.dataDir, back.id).disk, 'utf8')).toBe('early');
});

test('#restoreBackup restores the newest backup without --at', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  const dev = await ctx.imps.createImp({ name: 'dev' });

  writeFileSync(buildImpPaths(ctx.dataDir, dev.id).disk, 'early');

  await backups.runBackup();

  ctx.advance(60 * 60 * 1000);

  writeFileSync(buildImpPaths(ctx.dataDir, dev.id).disk, 'later');

  const later = await backups.runBackup();

  const lines = captureImpdLogs();

  await backups.restoreBackup({ name: 'dev', as: 'back' });

  const back = await readImpByName(ctx.db, 'back');

  invariant(back);

  expect(readFileSync(buildImpPaths(ctx.dataDir, back.id).disk, 'utf8')).toBe('later');

  expect(lines).toContain(
    `INFO impd.backup imp=back restored from ${later.snapshotId} (2026-10-02T01:00:00.000Z)`,
  );
});

test('#restoreBackup rejects a restore --at before every backup as NOT_FOUND', async () => {
  const ctx = await setupTest();

  ctx.setClock(Date.UTC(2026, 9, 2));

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await backups.runBackup();

  expect(
    backups.restoreBackup({ name: 'dev', as: 'back', at: new Date('2026-10-01T00:00:00Z') }),
  ).rejects.toMatchObject({
    code: 'NOT_FOUND',
    message: 'backup dev at 2026-10-01T00:00:00.000Z not found',
  });
});

test('#restoreBackup rejects a restore over an imp of the same name as CONFLICT', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await backups.runBackup();

  expect(backups.restoreBackup({ name: 'dev' })).rejects.toMatchObject({
    code: 'CONFLICT',
    data: { kind: 'imp', name: 'dev' },
  });
});

test('#restoreBackup rejects a restore of all imps on a host with imps as PRECONDITION_FAILED', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await backups.runBackup();

  expect(backups.restoreBackup({ all: true })).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: "impd has 1 imps already; restore --all --merge adds the backup's imps to them",
  });
});

test('#restoreBackup rejects a merged restore of all imps over a name in use as CONFLICT', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await backups.runBackup();

  expect(backups.restoreBackup({ all: true, merge: true })).rejects.toMatchObject({
    code: 'CONFLICT',
    data: { kind: 'imp', name: 'dev' },
  });
});

test('#restoreBackup rejects a restore that names neither an imp nor all of them as BAD_REQUEST', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  expect(backups.restoreBackup({})).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'restore one imp by name, or all of them',
  });
});

test('#restoreBackup rejects a restore that names an imp and all of them as BAD_REQUEST', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  expect(backups.restoreBackup({ name: 'dev', all: true })).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'restore one imp by name, or all of them',
  });
});

test('#restoreBackup rejects a restore of all imps under another name as BAD_REQUEST', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  expect(backups.restoreBackup({ all: true, as: 'back' })).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: '`as` renames one imp, not all of them',
  });
});

test('#restoreBackup restores every imp and its image on a fresh host, renaming an image whose name is taken', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  const dev = await ctx.imps.createImp({ name: 'dev' });

  writeFileSync(buildImpPaths(ctx.dataDir, dev.id).disk, 'now');

  await ctx.imps.createImp({ name: 'web' });
  await backups.runBackup();

  const fresh = await startTestImpd(ctx.stack);

  const freshBackups = createBackupService({
    dataDir: fresh.dataDir,
    backup: buildMockBackupConfig(),
    db: fresh.db,
    imps: fresh.imps,
    grants: fresh.broker,
    tokens: fresh.tokens,
    networks: createNetworkService({ db: fresh.db, egress: fresh.egress, imps: fresh.imps }),
    storage: fresh.storage,
    images: fresh.images,
    storageGate: fresh.storageGate,
    diskBudget: fresh.diskBudget,
    writeImageFiles,
    restic: buildStubRestic({ repoDir: ctx.repoDir, now: () => new Date(ctx.now()) }).restic,
    now: () => new Date(ctx.now()),
    freezer: { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() },
  });

  await fresh.createTestImage('other');
  await fresh.db.updateTable('images').set({ name: 'base' }).execute();

  const restored = await freshBackups.restoreBackup({ all: true });
  const freshDev = await readImpByName(fresh.db, 'dev');

  invariant(freshDev);

  expect(restored.imps.map((imp) => [imp.name, imp.state, imp.image])).toStrictEqual([
    ['dev', 'stopped', 'base-base'],
    ['web', 'stopped', 'base-base'],
  ]);

  expect(readFileSync(buildImpPaths(fresh.dataDir, freshDev.id).disk, 'utf8')).toBe('now');
});

test('#restoreBackup rejects a restored image as CONFLICT when its name and its tagged name are both taken', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await backups.runBackup();

  const fresh = await startTestImpd(ctx.stack);

  const freshBackups = createBackupService({
    dataDir: fresh.dataDir,
    backup: buildMockBackupConfig(),
    db: fresh.db,
    imps: fresh.imps,
    grants: fresh.broker,
    tokens: fresh.tokens,
    networks: createNetworkService({ db: fresh.db, egress: fresh.egress, imps: fresh.imps }),
    storage: fresh.storage,
    images: fresh.images,
    storageGate: fresh.storageGate,
    diskBudget: fresh.diskBudget,
    writeImageFiles,
    restic: buildStubRestic({ repoDir: ctx.repoDir, now: () => new Date(ctx.now()) }).restic,
    now: () => new Date(ctx.now()),
    freezer: { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() },
  });

  await fresh.createTestImage('other');
  await fresh.db.updateTable('images').set({ name: 'base' }).where('name', '=', 'other').execute();
  await fresh.createTestImage('third');

  await fresh.db
    .updateTable('images')
    .set({ name: 'base-base' })
    .where('name', '=', 'third')
    .execute();

  expect(freshBackups.restoreBackup({ name: 'dev' })).rejects.toMatchObject({
    code: 'CONFLICT',
    message: 'images base and base-base both exist; remove one to import this image',
    data: { kind: 'image', name: 'base-base' },
  });
});

test('#runBackup records templates with their source imp and an identity reset still owed', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  const templates = createTemplateService({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.imps,
    storage: ctx.storage,
    storageGate: ctx.storageGate,
    diskBudget: ctx.diskBudget,
    runImageEviction: ctx.images.runImageEviction,
    freezer: { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() },
  });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await ctx.imps.stopImp('dev');
  await templates.createTemplate('dev', 'tools');
  await templates.createTemplate('dev', 'spare');
  await ctx.imps.createImp({ name: 'copy', image: 'tools', start: false });

  const run = await backups.runBackup();

  const manifestText = readFileSync(join(ctx.repoDir, run.snapshotId, 'manifest.json'), 'utf8');
  const manifest = BackupManifestSchema.parse(JSON.parse(manifestText));

  expect(manifest.images.map((image) => [image.name, image.source, image.sourceImp])).toStrictEqual(
    [
      ['base', 'oci', null],
      ['spare', 'imp', 'dev'],
      ['tools', 'imp', 'dev'],
    ],
  );

  expect(manifest.imps.map((imp) => [imp.name, imp.identityResetPending])).toStrictEqual([
    ['copy', true],
    ['dev', false],
  ]);
});

test('#restoreBackup restores unused templates with all imps, tagging one whose name is taken', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  const templates = createTemplateService({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.imps,
    storage: ctx.storage,
    storageGate: ctx.storageGate,
    diskBudget: ctx.diskBudget,
    runImageEviction: ctx.images.runImageEviction,
    freezer: { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() },
  });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  const dev = await ctx.imps.createImp({ name: 'dev' });

  writeFileSync(buildImpPaths(ctx.dataDir, dev.id).disk, 'now');

  await ctx.imps.stopImp('dev');
  await templates.createTemplate('dev', 'tools');
  await templates.createTemplate('dev', 'spare');
  await ctx.imps.createImp({ name: 'copy', image: 'tools', start: false });
  await backups.runBackup();

  const tools = await readImageByName(ctx.db, 'tools');

  invariant(tools);

  const fresh = await startTestImpd(ctx.stack);

  const freshBackups = createBackupService({
    dataDir: fresh.dataDir,
    backup: buildMockBackupConfig(),
    db: fresh.db,
    imps: fresh.imps,
    grants: fresh.broker,
    tokens: fresh.tokens,
    networks: createNetworkService({ db: fresh.db, egress: fresh.egress, imps: fresh.imps }),
    storage: fresh.storage,
    images: fresh.images,
    storageGate: fresh.storageGate,
    diskBudget: fresh.diskBudget,
    writeImageFiles,
    restic: buildStubRestic({ repoDir: ctx.repoDir, now: () => new Date(ctx.now()) }).restic,
    now: () => new Date(ctx.now()),
    freezer: { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() },
  });

  await fresh.createTestImage('tools');

  const restored = await freshBackups.restoreBackup({ all: true });
  const spare = await readImageByName(fresh.db, 'spare');
  const copy = await readImpByName(fresh.db, 'copy');

  invariant(copy);

  expect(restored.imps.map((imp) => [imp.name, imp.image])).toStrictEqual([
    ['copy', `tools-${tools.digest.slice(-8)}`],
    ['dev', 'base'],
  ]);

  expect(spare).toMatchObject({ source: 'imp', sourceImp: 'dev' });
  expect(copy.isIdentityResetPending).toBeTrue();
  expect(readFileSync(buildImpPaths(fresh.dataDir, copy.id).disk, 'utf8')).toBe('now');
});

test('#buildBackupsOffError tells the caller to set a repository', () => {
  expect(buildBackupsOffError()).toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: 'backups are off: set IMP_BACKUP_REPOSITORY (docs/guides/configuration.md)',
  });
});

test('#restoreBackup leaves no imp behind when a restore fails part way', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  const dev = await ctx.imps.createImp({ name: 'dev' });
  const oneBytes = await ctx.storage.createCheckpoint(dev.id, 'cp-one');

  await createCheckpoint(
    ctx.db,
    buildMockNewCheckpoint({ id: 'cp-one', impId: dev.id, sizeBytes: oneBytes }),
  );

  const run = await backups.runBackup();

  const manifestText = readFileSync(join(ctx.repoDir, run.snapshotId, 'manifest.json'), 'utf8');
  const manifest = BackupManifestSchema.parse(JSON.parse(manifestText));

  rmSync(join(ctx.repoDir, run.snapshotId, manifest.imps[0]?.disk ?? ''));

  expect(backups.restoreBackup({ name: 'dev', as: 'copy' })).rejects.toThrow('ENOENT');

  const copy = await readImpByName(ctx.db, 'copy');
  const checkpoints = await ctx.db.selectFrom('checkpoints').select('id').execute();

  expect(ctx.restic.restores).toContain(`imps/${dev.id}/checkpoints/cp-one`);
  expect(copy).toBeUndefined();
  expect(checkpoints).toStrictEqual([{ id: 'cp-one' }]);
  expect(readdirSync(join(ctx.dataDir, 'backup', 'restore'))).toStrictEqual([]);
});

test('#restoreBackup logs an imp that a failed restore cannot remove', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });

  const run = await backups.runBackup();

  const manifestText = readFileSync(join(ctx.repoDir, run.snapshotId, 'manifest.json'), 'utf8');
  const manifest = BackupManifestSchema.parse(JSON.parse(manifestText));

  rmSync(join(ctx.repoDir, run.snapshotId, manifest.imps[0]?.disk ?? ''));

  await runSql(
    ctx.db,
    `CREATE TRIGGER keep_copies BEFORE DELETE ON imps WHEN OLD.name = 'copy'
    BEGIN SELECT RAISE(ABORT, 'imp rows kept'); END`,
  );

  const lines = captureImpdLogs();

  expect(backups.restoreBackup({ name: 'dev', as: 'copy' })).rejects.toThrow('ENOENT');

  expect(lines).toContain(
    'WARNING impd.backup imp=copy a failed restore left the imp: imp rows kept',
  );
});

test('#restoreBackup rejects a restore of a backup that holds no copy of the imp’s image', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });

  const run = await backups.runBackup();

  const manifestPath = join(ctx.repoDir, run.snapshotId, 'manifest.json');
  const manifest = BackupManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));

  writeFileSync(manifestPath, JSON.stringify({ ...manifest, images: [] }));

  expect(backups.restoreBackup({ name: 'dev', as: 'copy' })).rejects.toThrow(
    'the backup holds no image sha256:base',
  );
});

test('#runScheduled prunes and checks on the first scheduled run', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig({ intervalS: 3600 }),
  });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await backups.runScheduled();

  expect(ctx.restic.calls).toStrictEqual([
    'unlock',
    'backup',
    'forget',
    'unlock',
    'prune',
    'unlock',
    'check',
  ]);
});

test('#runScheduled runs nothing before the interval has passed', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig({ intervalS: 3600 }),
  });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await backups.runScheduled();

  const before = ctx.restic.calls.length;

  ctx.advance(30 * 60 * 1000);

  await backups.runScheduled();

  expect(ctx.restic.calls.slice(before)).toStrictEqual([]);
});

test('#runScheduled backs up without a prune or a check once the interval has passed', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig({ intervalS: 3600 }),
  });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await backups.runScheduled();

  const before = ctx.restic.calls.length;

  ctx.advance(60 * 60 * 1000);

  const lines = captureImpdLogs();

  await backups.runScheduled();

  expect(ctx.restic.calls.slice(before)).toStrictEqual(['unlock', 'backup', 'forget']);

  expect(lines).toContainEqual(
    expect.stringMatching(/^INFO impd\.backup snap2: 1 imps, 10 bytes added in \d+ms$/v),
  );
});

test('#runScheduled logs a failed weekly check loudly and reports it in the status', async () => {
  const ctx = await setupTest();

  ctx.setClock(Date.UTC(2026, 9, 2));

  const backups = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig({ intervalS: 3600 }),
  });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await backups.runScheduled();

  const before = ctx.restic.calls.length;

  ctx.restic.state.failCheck = true;

  ctx.advance(7 * 24 * 60 * 60 * 1000);

  await backups.runScheduled();

  const status = await backups.readStatus();

  expect(ctx.restic.calls.slice(before)).toStrictEqual([
    'unlock',
    'backup',
    'forget',
    'unlock',
    'prune',
    'unlock',
    'check',
  ]);

  expect(ctx.backupLogs).toContain(
    'ERROR impd.backup CHECK FAILED, the repository may be damaged: Fatal: pack 9f2c: ciphertext verification failed',
  );

  expect(status.lastCheck?.error).toContain('ciphertext verification failed');

  expect(status.points).toStrictEqual([
    { id: expect.toBeString(), time: new Date('2026-10-02T00:00:00Z'), imps: ['dev'] },
    { id: expect.toBeString(), time: new Date('2026-10-09T00:00:00Z'), imps: ['dev'] },
  ]);
});

test('#runScheduled tries a prune that met a lock again on the next tick, not the next run', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig({ intervalS: 3600 }),
  });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });

  ctx.restic.state.pruneErrors.push(
    new ResticError(
      'restic prune exited 11: unable to create lock in backend: repository is already locked exclusively by PID 7 on imp-host by root (UID 0, GID 0)',
      11,
    ),
  );

  await backups.runScheduled();

  const before = ctx.restic.calls.length;

  ctx.advance(5 * 60 * 1000);

  await backups.runScheduled();

  const status = await backups.readStatus();

  expect(ctx.backupLogs).toContain(
    'ERROR impd.backup PRUNE FAILED: restic prune exited 11: unable to create lock in backend: repository is already locked exclusively by PID 7 on imp-host by root (UID 0, GID 0)',
  );

  expect(ctx.restic.calls.slice(before)).toStrictEqual(['unlock', 'prune']);
  expect(status.lastPruneAt).toBeValidDate();
});

test('#runScheduled runs nothing on the tick after a prune it tried again succeeded', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig({ intervalS: 3600 }),
  });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });

  ctx.restic.state.pruneErrors.push(
    new ResticError('restic prune exited 11: unable to create lock in backend', 11),
  );

  await backups.runScheduled();

  ctx.advance(5 * 60 * 1000);

  await backups.runScheduled();

  const before = ctx.restic.calls.length;

  ctx.advance(5 * 60 * 1000);

  await backups.runScheduled();

  expect(ctx.restic.calls.slice(before)).toStrictEqual([]);
});

test('#runScheduled stops trying a prune again after six in a row meet a lock', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig({ intervalS: 3600 }),
  });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });

  ctx.restic.state.pruneErrors.push(
    ...Array.from(
      { length: 7 },
      () => new ResticError('restic prune exited 11: unable to create lock in backend', 11),
    ),
  );

  await backups.runScheduled();

  const before = ctx.restic.calls.length;

  for (let tick = 0; tick < 6; tick += 1) {
    ctx.advance(5 * 60 * 1000);

    await backups.runScheduled();
  }

  expect(ctx.restic.calls.slice(before).filter((call) => call === 'prune')).toHaveLength(5);
});

test('#runScheduled starts a new series of prune tries with the next run', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig({ intervalS: 3600 }),
  });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });

  ctx.restic.state.pruneErrors.push(
    ...Array.from(
      { length: 7 },
      () => new ResticError('restic prune exited 11: unable to create lock in backend', 11),
    ),
  );

  await backups.runScheduled();

  for (let tick = 0; tick < 6; tick += 1) {
    ctx.advance(5 * 60 * 1000);

    await backups.runScheduled();
  }

  const before = ctx.restic.calls.length;

  ctx.advance(60 * 60 * 1000);

  await backups.runScheduled();

  ctx.advance(5 * 60 * 1000);

  await backups.runScheduled();

  const status = await backups.readStatus();

  expect(ctx.restic.calls.slice(before)).toStrictEqual([
    'unlock',
    'backup',
    'forget',
    'unlock',
    'prune',
    'unlock',
    'prune',
  ]);

  expect(status.lastPruneAt).toBeValidDate();
});

test('#runScheduled leaves a prune that failed for another reason to the next run', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig({ intervalS: 3600 }),
  });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });

  ctx.restic.state.pruneErrors.push(
    new ResticError('restic prune exited 1: Fatal: bucket full', 1),
  );

  await backups.runScheduled();

  const before = ctx.restic.calls.length;

  ctx.advance(5 * 60 * 1000);

  await backups.runScheduled();

  expect(ctx.restic.calls.slice(before)).toStrictEqual([]);
});

test('#runScheduled prunes again with the next run after a prune failed for another reason', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig({ intervalS: 3600 }),
  });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });

  ctx.restic.state.pruneErrors.push(
    new ResticError('restic prune exited 1: Fatal: bucket full', 1),
  );

  await backups.runScheduled();

  const before = ctx.restic.calls.length;

  ctx.advance(60 * 60 * 1000);

  await backups.runScheduled();

  expect(ctx.restic.calls.slice(before)).toStrictEqual([
    'unlock',
    'backup',
    'forget',
    'unlock',
    'prune',
  ]);
});

test('#runBackup leaves an imp being created out of the run', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  const dev = await ctx.imps.createImp({ name: 'dev' });

  await updateImpState(ctx.db, dev.id, { reason: 'failed', state: 'creating' });

  const run = await backups.runBackup();

  expect(run.imps).toStrictEqual([]);
  expect(run.skipped).toStrictEqual([{ name: 'dev', reason: 'being created' }]);
});

test('#runBackup leaves out an imp replaced under its name since the database copy', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'a' });
  await ctx.imps.createImp({ name: 'dev' });
  await ctx.imps.stopImp('dev');

  const backups = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig(),
    freezer: {
      freeze: async () => {
        await ctx.imps.destroyImp('dev');
        await ctx.imps.createImp({ name: 'dev' });
      },
      thaw: () => Promise.resolve(),
    },
  });

  const run = await backups.runBackup();

  expect(run.imps).toStrictEqual(['a']);
  expect(run.skipped).toStrictEqual([{ name: 'dev', reason: 'replaced since the database copy' }]);

  expect(ctx.backupLogs).toContain(
    'WARNING impd.backup imp=dev left out: replaced since the database copy',
  );
});

test('#runBackup puts no secret, key, password or token of the host in a backup', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_never_backed_up' });
  await ctx.broker.addGrant('dev', 'gh');

  mkdirSync(join(ctx.dataDir, 'tls'), { recursive: true });
  writeFileSync(join(ctx.dataDir, 'tls', 'account.json'), 'acme-account-key-text');
  writeFileSync(join(ctx.dataDir, 'restic-password'), 'restic-password-text');
  writeFileSync(join(ctx.dataDir, 'token'), 'api-token-text');

  const run = await backups.runBackup();

  const snapshotDir = join(ctx.repoDir, run.snapshotId);

  const files = readdirSync(snapshotDir, { recursive: true, withFileTypes: true }).filter((entry) =>
    entry.isFile(),
  );

  const texts = files
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'latin1'))
    .join('\n');

  expect(files.map((entry) => join(entry.parentPath, entry.name))).not.toSatisfyAny(
    (path: string) =>
      /secrets|broker|tls|password|token|db\.sqlite/v.test(path.slice(snapshotDir.length)),
  );

  expect(texts).not.toMatch(
    /ghp_never_backed_up|acme-account-key-text|restic-password-text|api-token-text|PRIVATE KEY/v,
  );
});

test('#runBackup records an imp’s grants by secret name only', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_never_backed_up' });
  await ctx.broker.addGrant('dev', 'gh');

  const run = await backups.runBackup();

  const manifestText = readFileSync(join(ctx.repoDir, run.snapshotId, 'manifest.json'), 'utf8');
  const manifest = BackupManifestSchema.parse(JSON.parse(manifestText));

  expect(manifest.imps[0]?.grants).toStrictEqual(['gh']);
});

test('#runBackup records a filtered grant apart from the grants of the whole host', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_value' });
  await ctx.broker.addSecret({ name: 'npm', kind: 'npm', value: 'npm_value' });
  await ctx.broker.addGrant('dev', 'gh', null, { methods: ['GET'], paths: ['/repos/**'] });
  await ctx.broker.addGrant('dev', 'npm');

  const run = await backups.runBackup();

  const manifestText = readFileSync(join(ctx.repoDir, run.snapshotId, 'manifest.json'), 'utf8');
  const manifest = BackupManifestSchema.parse(JSON.parse(manifestText));

  expect(manifest.imps[0]?.grants).toStrictEqual(['npm']);

  expect(manifest.imps[0]?.filteredGrants).toStrictEqual([
    { secret: 'gh', filter: { methods: ['GET'], paths: ['/repos/**'] } },
  ]);
});

test('#restoreBackup restores a filtered grant with its filter', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_value' });
  await ctx.broker.addSecret({ name: 'npm', kind: 'npm', value: 'npm_value' });
  await ctx.broker.addGrant('dev', 'gh', null, { methods: ['GET'] });
  await ctx.broker.addGrant('dev', 'npm');
  await backups.runBackup();
  await backups.restoreBackup({ name: 'dev', as: 'back' });

  const grants = await ctx.broker.listGrantDetails('back');

  expect(grants).toStrictEqual([
    { secret: 'gh', filter: { methods: ['GET'] } },
    { secret: 'npm', filter: null },
  ]);
});

test('#restoreBackup regrants a restored imp by name and skips a secret that is gone', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_value' });
  await ctx.broker.addSecret({ name: 'npm-old', kind: 'npm', value: 'npm_value' });
  await ctx.broker.addGrant('dev', 'gh');
  await ctx.broker.addGrant('dev', 'npm-old');
  await backups.runBackup();
  await ctx.broker.deleteSecret('npm-old');

  const result = await backups.restoreBackup({ name: 'dev', as: 'back' });
  const grants = await ctx.broker.listGrants('back');

  expect(grants).toStrictEqual(['gh']);

  expect(result.skippedGrants).toStrictEqual([
    { imp: 'back', secret: 'npm-old', reason: expect.toInclude('npm-old') },
  ]);
});

test('#restoreBackup restores an imp’s egress policy and its allow list', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await ctx.egress.setPolicy('dev', { mode: 'box', allow: ['github.com', '*.npmjs.org'] });
  await backups.runBackup();
  await backups.restoreBackup({ name: 'dev', as: 'back' });

  const policy = await ctx.egress.readPolicy('back');

  expect(policy).toStrictEqual({ mode: 'box', allow: ['github.com', '*.npmjs.org'] });
});

test('#runBackup records the networks an imp is on in the manifest', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });

  const networks = createNetworkService({ db: ctx.db, egress: ctx.egress, imps: ctx.imps });

  await networks.createNetwork('lab');
  await networks.joinNetwork('lab', 'dev');

  const run = await backups.runBackup();

  const manifestText = readFileSync(join(ctx.repoDir, run.snapshotId, 'manifest.json'), 'utf8');
  const manifest = BackupManifestSchema.parse(JSON.parse(manifestText));

  expect(manifest.imps[0]?.networks).toStrictEqual(['lab']);
});

test('#restoreBackup puts a restored imp back on its networks, made again when gone', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });

  const networks = createNetworkService({ db: ctx.db, egress: ctx.egress, imps: ctx.imps });

  await networks.createNetwork('lab');
  await networks.joinNetwork('lab', 'dev');
  await backups.runBackup();
  await networks.removeNetwork('lab');
  await backups.restoreBackup({ name: 'dev', as: 'back' });

  const restored = await networks.listNetworks();

  expect(restored.map((network) => [network.name, network.imps])).toStrictEqual([
    ['lab', ['back']],
  ]);
});

test('#restoreBackup restores an egress policy this impd cannot read as none, never more open', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });

  const run = await backups.runBackup();

  const manifestPath = join(ctx.repoDir, run.snapshotId, 'manifest.json');
  const manifest = BackupManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));

  writeFileSync(
    manifestPath,
    JSON.stringify({
      ...manifest,
      imps: [{ ...manifest.imps[0], egressPolicy: 'granted-only' }],
    }),
  );

  await backups.restoreBackup({ name: 'dev', as: 'back' });

  const policy = await ctx.egress.readPolicy('back');

  expect(policy).toStrictEqual({ mode: 'none', allow: [] });

  expect(ctx.backupLogs).toContain(
    'WARNING impd.backup imp=back unknown egress policy "granted-only"; imported as none',
  );
});

test('#restoreBackup restores one file at a time and leaves none behind', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  const dev = await ctx.imps.createImp({ name: 'dev' });
  const oneBytes = await ctx.storage.createCheckpoint(dev.id, 'cp-one');

  await createCheckpoint(
    ctx.db,
    buildMockNewCheckpoint({ id: 'cp-one', impId: dev.id, sizeBytes: oneBytes }),
  );

  await backups.runBackup();

  const before = ctx.restic.restores.length;

  await backups.restoreBackup({ name: 'dev', as: 'copy' });

  expect(ctx.restic.restores.slice(before)).toStrictEqual([
    `imps/${dev.id}/checkpoints/cp-one`,
    `imps/${dev.id}/disk`,
  ]);

  expect(readdirSync(join(ctx.dataDir, 'backup', 'restore'))).toStrictEqual([]);
});

test('#runScheduled ends the backoff of a failed scheduled run after a manual run that succeeds', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig({ intervalS: 3600 }),
  });

  ctx.restic.state.failBackup = true;

  const failed = await backups.runScheduled().catch((error: unknown) => error);

  ctx.restic.state.failBackup = false;

  ctx.advance(60 * 1000);

  await backups.runBackup();

  const before = ctx.restic.calls.length;

  ctx.advance(5 * 60 * 1000);

  await backups.runScheduled();

  expect(failed).toBeInstanceOf(Error);
  expect(ctx.restic.calls.slice(before)).toStrictEqual([]);
});

test('#runScheduled waits twice as long after each failed scheduled run, up to the interval', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig({ intervalS: 3600 }),
  });

  const ticks: boolean[] = [];

  ctx.restic.state.failBackup = true;

  for (const minutes of [0, 4, 1, 9, 1, 20, 40, 59, 1]) {
    ctx.advance(minutes * 60 * 1000);

    const before = ctx.restic.calls.length;

    await backups.runScheduled().catch(() => {});

    ticks.push(ctx.restic.calls.length > before);
  }

  expect(ticks).toStrictEqual([true, false, true, false, true, true, true, false, true]);
});

test('#runScheduled waits the whole interval again after a scheduled run that succeeds past a failure', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig({ intervalS: 3600 }),
  });

  ctx.restic.state.failBackup = true;

  await backups.runScheduled().catch(() => {});

  ctx.restic.state.failBackup = false;

  ctx.advance(5 * 60 * 1000);

  await backups.runScheduled();

  const ticks: boolean[] = [];

  for (const minutes of [5, 25, 30]) {
    ctx.advance(minutes * 60 * 1000);

    const before = ctx.restic.calls.length;

    await backups.runScheduled();

    ticks.push(ctx.restic.calls.length > before);
  }

  expect(ticks).toStrictEqual([false, false, true]);
});

test('#runBackup records the blocks each disk file holds in the manifest, not its apparent size', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  const dev = await ctx.imps.createImp({ name: 'dev' });

  writeFileSync(buildImpPaths(ctx.dataDir, dev.id).disk, 'one');

  const oneBytes = await ctx.storage.createCheckpoint(dev.id, 'cp-one');

  await createCheckpoint(
    ctx.db,
    buildMockNewCheckpoint({ id: 'cp-one', impId: dev.id, sizeBytes: oneBytes }),
  );

  writeFileSync(buildImpPaths(ctx.dataDir, dev.id).disk, 'now');

  const run = await backups.runBackup();

  const manifestText = readFileSync(join(ctx.repoDir, run.snapshotId, 'manifest.json'), 'utf8');
  const manifest = BackupManifestSchema.parse(JSON.parse(manifestText));

  expect(manifest.imps[0]?.usedBytes).toBeWithin(1, 1024 ** 2);
  expect(manifest.imps[0]?.checkpoints[0]?.usedBytes).toBeWithin(1, 1024 ** 2);
});

test('#restoreBackup holds the storage gate for a restored image and disk room for each restored file', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  const dev = await ctx.imps.createImp({ name: 'dev' });

  writeFileSync(buildImpPaths(ctx.dataDir, dev.id).disk, 'one');

  const oneBytes = await ctx.storage.createCheckpoint(dev.id, 'cp-one');

  await createCheckpoint(
    ctx.db,
    buildMockNewCheckpoint({ id: 'cp-one', impId: dev.id, sizeBytes: oneBytes }),
  );

  writeFileSync(buildImpPaths(ctx.dataDir, dev.id).disk, 'now');

  const run = await backups.runBackup();

  const manifestText = readFileSync(join(ctx.repoDir, run.snapshotId, 'manifest.json'), 'utf8');
  const manifest = BackupManifestSchema.parse(JSON.parse(manifestText));
  const [recorded] = manifest.imps;

  invariant(recorded);

  const [checkpoint] = recorded.checkpoints;

  invariant(checkpoint);

  const usedBytes = recorded.usedBytes ?? -1;
  const checkpointUsedBytes = checkpoint.usedBytes ?? -1;

  const fresh = await startTestImpd(ctx.stack);

  const freshRestic = buildStubRestic({ repoDir: ctx.repoDir, now: () => new Date(ctx.now()) });

  const freshBackups = createBackupService({
    dataDir: fresh.dataDir,
    backup: buildMockBackupConfig(),
    db: fresh.db,
    imps: fresh.imps,
    grants: fresh.broker,
    tokens: fresh.tokens,
    networks: createNetworkService({ db: fresh.db, egress: fresh.egress, imps: fresh.imps }),
    storage: fresh.storage,
    images: fresh.images,
    storageGate: fresh.storageGate,
    diskBudget: fresh.diskBudget,
    writeImageFiles,
    restic: freshRestic.restic,
    now: () => new Date(ctx.now()),
    freezer: { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() },
  });

  const seen: { directory: string; isJoined: boolean; pendingBytes: number }[] = [];

  freshRestic.state.onRestore = async (directory) => {
    const status = await fresh.diskBudget.readStatus();

    seen.push({
      directory,
      isJoined: fresh.storageGate.countInFlight() > 0,
      pendingBytes: status.pendingBytes,
    });
  };

  await freshBackups.restoreBackup({ name: 'dev' });

  expect(seen).toStrictEqual([
    {
      directory: 'images/base',
      isJoined: true,
      pendingBytes: expect.toSatisfy((bytes: number) => bytes > 0),
    },

    { directory: dirname(checkpoint.disk), isJoined: true, pendingBytes: 2 * checkpointUsedBytes },
    { directory: dirname(recorded.disk), isJoined: true, pendingBytes: 2 * usedBytes },
  ]);
});

test('#restoreBackup grants a restored imp against the secret as it is now', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_value' });
  await ctx.broker.addGrant('dev', 'gh');
  await backups.runBackup();

  await ctx.broker.addSecret({
    name: 'gh',
    kind: 'custom',
    value: 'ghp_other',
    rules: [{ host: 'api.github.com', header: 'authorization', scheme: 'bearer' }],
    replace: true,
    rebind: true,
  });

  await backups.restoreBackup({ name: 'dev', as: 'back' });

  const back = await readImpByName(ctx.db, 'back');
  const secret = await readSecret(ctx.db, 'gh');

  invariant(back);
  invariant(secret);

  const rows = await ctx.db.selectFrom('grants').selectAll().execute();
  const isGranted = await ctx.broker.isGranted(back.id, 'api.github.com');

  expect(rows).toStrictEqual([
    { imp_id: back.id, secret_name: 'gh', secret_generation: secret.generation, filter: null },
  ]);

  expect(isGranted).toBeTrue();
});

test('#restoreBackup grants a restored imp so that a token’s list entry from before a rebind cannot revoke it', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_value' });
  await ctx.broker.addGrant('dev', 'gh');

  const made = await ctx.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['back*'],
    grantable: ['gh'],
  });

  const caller = ctx.tokens.authenticate(made.secret);

  invariant(caller);

  const tokenId = caller.tokenId;
  const [entry] = caller.grantable;
  const generation = entry?.generation;

  invariant(tokenId !== null);
  invariant(generation !== undefined);

  await backups.runBackup();

  await ctx.broker.addSecret({
    name: 'gh',
    kind: 'custom',
    value: 'ghp_other',
    rules: [{ host: 'api.github.com', header: 'authorization', scheme: 'bearer' }],
    replace: true,
    rebind: true,
  });

  await backups.restoreBackup({ name: 'dev', as: 'back' });

  expect(ctx.broker.removeGrant('back', 'gh', { tokenId, generation })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    data: { reason: 'not_grantable' },
  });
});

test('#restoreBackup leaves the host’s imps, secrets and grants as they were when a restore fails', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  const dev = await ctx.imps.createImp({ name: 'dev' });
  const oneBytes = await ctx.storage.createCheckpoint(dev.id, 'cp-one');

  await createCheckpoint(
    ctx.db,
    buildMockNewCheckpoint({ id: 'cp-one', impId: dev.id, sizeBytes: oneBytes }),
  );

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_value' });
  await ctx.broker.addGrant('dev', 'gh');

  const run = await backups.runBackup();

  const manifestText = readFileSync(join(ctx.repoDir, run.snapshotId, 'manifest.json'), 'utf8');
  const manifest = BackupManifestSchema.parse(JSON.parse(manifestText));

  const checkpointsBefore = await ctx.db.selectFrom('checkpoints').selectAll().execute();

  const impsBefore = await ctx.db
    .selectFrom('imps')
    .select(['id', 'name'])
    .orderBy('name')
    .execute();

  const secretsBefore = await ctx.db.selectFrom('secrets').selectAll().execute();
  const grantsBefore = await ctx.db.selectFrom('grants').selectAll().execute();

  rmSync(join(ctx.repoDir, run.snapshotId, manifest.imps[0]?.disk ?? ''));

  expect(backups.restoreBackup({ name: 'dev', as: 'copy' })).rejects.toThrow('ENOENT');

  const impsAfter = await ctx.db
    .selectFrom('imps')
    .select(['id', 'name'])
    .orderBy('name')
    .execute();

  const secretsAfter = await ctx.db.selectFrom('secrets').selectAll().execute();
  const grantsAfter = await ctx.db.selectFrom('grants').selectAll().execute();
  const checkpointsAfter = await ctx.db.selectFrom('checkpoints').selectAll().execute();

  expect(ctx.restic.restores).toContain(`imps/${dev.id}/checkpoints/cp-one`);
  expect(impsAfter).toStrictEqual(impsBefore);
  expect(secretsAfter).toStrictEqual(secretsBefore);
  expect(grantsAfter).toStrictEqual(grantsBefore);
  expect(checkpointsAfter).toStrictEqual(checkpointsBefore);
});

test('#runBackup puts no file of an imp created with backup off in the snapshot', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  const dev = await ctx.imps.createImp({ name: 'dev' });
  const chat = await ctx.imps.createImp({ name: 'chat', isBackedUp: false });

  writeFileSync(buildImpPaths(ctx.dataDir, chat.id).disk, 'transcript-in-plain-text');

  const chatBytes = await ctx.storage.createCheckpoint(chat.id, 'cp-chat');

  await createCheckpoint(
    ctx.db,
    buildMockNewCheckpoint({ id: 'cp-chat', impId: chat.id, sizeBytes: chatBytes }),
  );

  const run = await backups.runBackup();

  const snapshotDir = join(ctx.repoDir, run.snapshotId);

  const files = readdirSync(snapshotDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(snapshotDir.length));

  const texts = files.map((file) => readFileSync(join(snapshotDir, file), 'latin1')).join('\n');

  expect(files).toContain(`/${BACKUP_TREE.buildDisk(dev.id)}`);
  expect(files).not.toSatisfyAny((file: string) => file.includes(chat.id));
  expect(texts).not.toInclude('transcript-in-plain-text');
});

test('#runBackup names an imp created with backup off in the run, the tags and the manifest, with why', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await ctx.imps.createImp({ name: 'chat', isBackedUp: false });

  const run = await backups.runBackup();

  const manifestText = readFileSync(join(ctx.repoDir, run.snapshotId, 'manifest.json'), 'utf8');
  const manifest = BackupManifestSchema.parse(JSON.parse(manifestText));
  const [snapshot] = ctx.restic.readSnapshots();

  expect(run.imps).toStrictEqual(['dev']);
  expect(run.skipped).toStrictEqual([]);
  expect(run.excluded).toStrictEqual([{ name: 'chat', reason: 'created with backup off' }]);
  expect(manifest.imps.map((imp) => imp.name)).toStrictEqual(['dev']);
  expect(manifest.excluded).toStrictEqual([{ name: 'chat', reason: 'created with backup off' }]);

  expect(snapshot?.tags).toStrictEqual([
    'imp-backup',
    expect.stringMatching(/^run=/v),
    'imp=dev',
    'excluded=chat',
  ]);
});

test('#restoreBackup rejects a restore of an imp created with backup off as PRECONDITION_FAILED, with why', async () => {
  const ctx = await setupTest();

  ctx.setClock(Date.UTC(2026, 9, 2));

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'chat', isBackedUp: false });

  const run = await backups.runBackup();

  await ctx.imps.destroyImp('chat');

  expect(backups.restoreBackup({ name: 'chat' })).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: `imp chat is left out of backups (created with backup off): backup ${run.snapshotId} (2026-10-02T00:00:00.000Z) holds none of its files`,
  });
});

test('#restoreBackup lists an imp created with backup off as not restorable, with why, in a restore of all imps', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await ctx.imps.createImp({ name: 'chat', isBackedUp: false });
  await backups.runBackup();
  await ctx.imps.destroyImp('dev');
  await ctx.imps.destroyImp('chat');

  const restored = await backups.restoreBackup({ all: true });

  expect(restored.imps.map((imp) => imp.name)).toStrictEqual(['dev']);

  expect(restored.notRestorable).toStrictEqual([
    { imp: 'chat', reason: 'created with backup off' },
  ]);
});

test('#runBackup puts the database copy, with the named tokens, in the snapshot with the database setting on', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig({ database: true }),
  });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await ctx.tokens.create({ name: 'agent', scope: 'exec', imps: ['dev'] });

  const run = await backups.runBackup();

  const snapshotDir = join(ctx.repoDir, run.snapshotId);

  const copy = new Database(join(snapshotDir, 'database', 'impd.sqlite'), { readonly: true });

  onTestFinished(() => {
    copy.close();
  });

  const manifestText = readFileSync(join(snapshotDir, 'manifest.json'), 'utf8');

  expect(readdirSync(snapshotDir)).toIncludeSameMembers([
    'database',
    'images',
    'imps',
    'manifest.json',
  ]);

  expect(copy.query('SELECT name FROM tokens').all()).toStrictEqual([{ name: 'agent' }]);

  expect(BackupManifestSchema.parse(JSON.parse(manifestText)).database).toStrictEqual({
    file: 'database/impd.sqlite',
    sizeBytes: statSync(join(snapshotDir, 'database', 'impd.sqlite')).size,
  });
});

test('#runBackup puts no secret value, key, password or root token in a backup with the database copy', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig({ database: true }),
  });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_never_backed_up' });
  await ctx.broker.addGrant('dev', 'gh');

  const made = await ctx.tokens.create({ name: 'agent', scope: 'exec', imps: ['dev'] });

  mkdirSync(join(ctx.dataDir, 'tls'), { recursive: true });
  writeFileSync(join(ctx.dataDir, 'tls', 'account.json'), 'acme-account-key-text');
  writeFileSync(join(ctx.dataDir, 'restic-password'), 'restic-password-text');
  writeFileSync(join(ctx.dataDir, 'token'), 'api-token-text');

  const run = await backups.runBackup();

  const snapshotDir = join(ctx.repoDir, run.snapshotId);

  const files = readdirSync(snapshotDir, { recursive: true, withFileTypes: true }).filter((entry) =>
    entry.isFile(),
  );

  const texts = files
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'latin1'))
    .join('\n');

  const [, tokenSecret = ''] = made.secret.split('.');

  expect(files.map((entry) => join(entry.parentPath, entry.name))).not.toSatisfyAny(
    (path: string) => /secrets|broker|tls|password|token/v.test(path.slice(snapshotDir.length)),
  );

  expect(texts).not.toMatch(
    /ghp_never_backed_up|acme-account-key-text|restic-password-text|api-token-text|PRIVATE KEY/v,
  );

  expect(texts).not.toInclude(tokenSecret);
});

test('#runBackup holds the database copy’s size from the disk budget while it writes the copy', async () => {
  const ctx = await setupTest();

  const held: number[] = [];

  const backups = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig({ database: true }),
    diskBudget: {
      requireRoom: (bytes) => ctx.diskBudget.requireRoom(bytes),
      withRoom: (bytes, task) => {
        held.push(bytes);

        return ctx.diskBudget.withRoom(bytes, task);
      },
    },
  });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });

  const run = await backups.runBackup();

  const copyBytes = statSync(join(ctx.repoDir, run.snapshotId, 'database', 'impd.sqlite')).size;

  expect(held).toStrictEqual([copyBytes]);
});

test('#runBackup takes the database copy out of the next snapshot once the setting is off', async () => {
  const ctx = await setupTest();

  const withCopy = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig({ database: true }),
  });

  const withoutCopy = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig({ database: false }),
  });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await withCopy.runBackup();

  const run = await withoutCopy.runBackup();

  const snapshotDir = join(ctx.repoDir, run.snapshotId);
  const manifestText = readFileSync(join(snapshotDir, 'manifest.json'), 'utf8');

  expect(readdirSync(snapshotDir)).toIncludeSameMembers(['images', 'imps', 'manifest.json']);
  expect(BackupManifestSchema.parse(JSON.parse(manifestText)).database).toBeNull();
});

test('#restoreBackup brings back the named tokens, the secrets and the grants on a fresh host from the database copy', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig({ database: true }),
  });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_value' });
  await ctx.broker.addGrant('dev', 'gh');

  const made = await ctx.tokens.create({ name: 'agent', scope: 'exec', imps: ['dev'] });
  const run = await backups.runBackup();
  const fresh = await startTestImpd(ctx.stack);

  const freshBackups = createBackupService({
    dataDir: fresh.dataDir,
    backup: buildMockBackupConfig(),
    db: fresh.db,
    imps: fresh.imps,
    grants: fresh.broker,
    tokens: fresh.tokens,
    networks: createNetworkService({ db: fresh.db, egress: fresh.egress, imps: fresh.imps }),
    storage: fresh.storage,
    images: fresh.images,
    storageGate: fresh.storageGate,
    diskBudget: fresh.diskBudget,
    writeImageFiles,
    restic: buildStubRestic({ repoDir: ctx.repoDir, now: () => new Date(ctx.now()) }).restic,
    now: () => new Date(ctx.now()),
    freezer: { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() },
  });

  const lines = captureImpdLogs();

  const restored = await freshBackups.restoreBackup({ all: true });
  const grants = await fresh.broker.listGrants('dev');

  expect(restored.database).toStrictEqual({ tokens: ['agent'], secrets: ['gh'], skipped: [] });
  expect(restored.skippedGrants).toStrictEqual([]);

  expect(fresh.tokens.authenticate(made.secret)).toMatchObject({
    name: 'agent',
    scope: 'exec',
    imps: ['dev'],
  });

  expect(grants).toStrictEqual(['gh']);

  expect(lines).toContain(
    `INFO impd.backup restored 1 tokens and 1 secrets from ${run.snapshotId}`,
  );
});

test('#restoreBackup holds the database copy’s size from the disk budget while it restores the copy', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig({ database: true }),
  });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });

  const run = await backups.runBackup();
  const fresh = await startTestImpd(ctx.stack);

  const freshRestic = buildStubRestic({ repoDir: ctx.repoDir, now: () => new Date(ctx.now()) });

  const freshBackups = createBackupService({
    dataDir: fresh.dataDir,
    backup: buildMockBackupConfig(),
    db: fresh.db,
    imps: fresh.imps,
    grants: fresh.broker,
    tokens: fresh.tokens,
    networks: createNetworkService({ db: fresh.db, egress: fresh.egress, imps: fresh.imps }),
    storage: fresh.storage,
    images: fresh.images,
    storageGate: fresh.storageGate,
    diskBudget: fresh.diskBudget,
    writeImageFiles,
    restic: freshRestic.restic,
    now: () => new Date(ctx.now()),
    freezer: { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() },
  });

  const seen: { directory: string; pendingBytes: number }[] = [];

  freshRestic.state.onRestore = async (directory) => {
    const status = await fresh.diskBudget.readStatus();

    seen.push({ directory, pendingBytes: status.pendingBytes });
  };

  await freshBackups.restoreBackup({ all: true });

  const copyBytes = statSync(join(ctx.repoDir, run.snapshotId, 'database', 'impd.sqlite')).size;

  expect(seen).toPartiallyContain({ directory: 'database', pendingBytes: copyBytes });
});

test('#restoreBackup refuses a backup whose manifest names its database copy at another path', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig({ database: true }),
  });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });

  const run = await backups.runBackup();

  const manifestPath = join(ctx.repoDir, run.snapshotId, 'manifest.json');
  const manifest = BackupManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));

  writeFileSync(
    manifestPath,
    JSON.stringify({ ...manifest, database: { file: '../../x/impd.sqlite', sizeBytes: 1 } }),
  );

  await ctx.imps.destroyImp('dev');

  expect(backups.restoreBackup({ all: true })).rejects.toThrow(
    'the backup names its database copy at ../../x/impd.sqlite, not database/impd.sqlite',
  );
});

test('#restoreBackup restores a token’s grantable list on a fresh host, so the token still grants its secret', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig({ database: true }),
  });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_value' });

  const made = await ctx.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev'],
    grantable: ['gh'],
  });

  await backups.runBackup();

  const fresh = await startTestImpd(ctx.stack);

  const freshBackups = createBackupService({
    dataDir: fresh.dataDir,
    backup: buildMockBackupConfig(),
    db: fresh.db,
    imps: fresh.imps,
    grants: fresh.broker,
    tokens: fresh.tokens,
    networks: createNetworkService({ db: fresh.db, egress: fresh.egress, imps: fresh.imps }),
    storage: fresh.storage,
    images: fresh.images,
    storageGate: fresh.storageGate,
    diskBudget: fresh.diskBudget,
    writeImageFiles,
    restic: buildStubRestic({ repoDir: ctx.repoDir, now: () => new Date(ctx.now()) }).restic,
    now: () => new Date(ctx.now()),
    freezer: { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() },
  });

  await freshBackups.restoreBackup({ all: true });

  const caller = fresh.tokens.authenticate(made.secret);

  invariant(caller);

  const tokenId = caller.tokenId;
  const [entry] = caller.grantable;
  const generation = entry?.generation;

  invariant(tokenId !== null);
  invariant(generation !== undefined);

  await fresh.broker.addGrant('dev', 'gh', { tokenId, generation });

  const grants = await fresh.broker.listGrants('dev');

  expect(grants).toStrictEqual(['gh']);
});

test('#restoreBackup brings back no token or secret in a restore of one imp from a backup with the database copy', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig({ database: true }),
  });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_value' });
  await ctx.tokens.create({ name: 'agent', scope: 'exec', imps: ['dev'] });
  await backups.runBackup();

  const fresh = await startTestImpd(ctx.stack);

  const freshBackups = createBackupService({
    dataDir: fresh.dataDir,
    backup: buildMockBackupConfig(),
    db: fresh.db,
    imps: fresh.imps,
    grants: fresh.broker,
    tokens: fresh.tokens,
    networks: createNetworkService({ db: fresh.db, egress: fresh.egress, imps: fresh.imps }),
    storage: fresh.storage,
    images: fresh.images,
    storageGate: fresh.storageGate,
    diskBudget: fresh.diskBudget,
    writeImageFiles,
    restic: buildStubRestic({ repoDir: ctx.repoDir, now: () => new Date(ctx.now()) }).restic,
    now: () => new Date(ctx.now()),
    freezer: { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() },
  });

  const restored = await freshBackups.restoreBackup({ name: 'dev' });
  const secrets = await fresh.broker.listSecrets();

  expect(restored.database).toBeUndefined();
  expect(fresh.tokens.list()).toStrictEqual([]);
  expect(secrets).toStrictEqual([]);
});
