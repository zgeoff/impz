import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMockNewImage } from '../../../testing/imps/build-mock-new-image';
import { buildMockNewImp } from '../../../testing/imps/build-mock-new-imp';
import { runSql } from '../../../testing/platform/run-sql';
import { startTestImpd } from '../../../testing/start-test-impd';
import { buildStubStoragePressure } from '../../../testing/vm/build-stub-storage-pressure';
import { createImage, readImageByName } from '../../platform/db/images';
import { createImp, readImpByName } from '../../platform/db/imps';
import { buildImagePaths, buildImpPaths } from '../../vm/storage/data-layout';
import { createXfsBackend } from '../../vm/storage/xfs-backend';
import { BUILDER_IMAGE } from './builder-imps';

async function setupTest(options: Readonly<{ isStorageFull?: boolean }> = {}) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'template-service-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const events: string[] = [];

  // a test sets this to run work while a template's clone is under way
  const clones = { after: (): Promise<unknown> => Promise.resolve() };

  const cloneDisk = async (source: string, target: string) => {
    await copyFile(source, target);

    events.push(`clone ${source.slice(dataDir.length)}`);

    await clones.after();
  };

  const harness = await startTestImpd(stack, {
    dataDir,
    cloneDisk,
    ...(options.isStorageFull === true && {
      env: { IMP_IMAGE_EVICT_HIGH_PERCENT: '80', IMP_IMAGE_EVICT_LOW_PERCENT: '60' },
      createStorage: (directory: string) => ({
        ...createXfsBackend({ dataDir: directory, cloneFile: cloneDisk }),
        ...buildStubStoragePressure({ usedBytes: 90, availableBytes: 10, freedBytes: 1 }),
      }),
    }),
    boundaries: {
      freezer: {
        freeze: () => {
          events.push('freeze');

          return Promise.resolve();
        },
        thaw: () => {
          events.push('thaw');

          return Promise.resolve();
        },
      },
    },
  });

  return Object.assign(harness, { events, clones });
}

test('it freezes a running imp around the clone of its disk', async () => {
  const ctx = await setupTest();

  const baseImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, baseImage.digest).rootfs, 'rootfs');

  await createImage(ctx.db, baseImage);

  const dev = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  const before = ctx.events.length;

  await ctx.impd.templates.createTemplate('dev', 'tools');

  expect(ctx.events.slice(before)).toStrictEqual([
    'freeze',
    `clone /imps/${dev.id}/disk.ext4`,
    'thaw',
  ]);
});

test('it adds a template image named for its imp', async () => {
  const ctx = await setupTest();

  const baseImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, baseImage.digest).rootfs, 'rootfs');

  await createImage(ctx.db, baseImage);

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  const image = await ctx.impd.templates.createTemplate('dev', 'tools');

  expect(image).toMatchObject({
    name: 'tools',
    ref: 'imp:dev',
    source: 'imp',
    sourceImp: 'dev',
    digest: expect.stringMatching(/^imp-[\da-f\-]{36}$/v) as unknown,
  });
});

test('it writes the imp disk as the template rootfs', async () => {
  const ctx = await setupTest();

  const baseImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, baseImage.digest).rootfs, 'rootfs');

  await createImage(ctx.db, baseImage);

  const dev = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  await writeFile(buildImpPaths(ctx.dataDir, dev.id).disk, 'tools installed');

  const image = await ctx.impd.templates.createTemplate('dev', 'tools');

  expect(readFile(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'utf8')).resolves.toBe(
    'tools installed',
  );
});

test('it copies the source image config into the template', async () => {
  const ctx = await setupTest();

  const baseImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, baseImage.digest).rootfs, 'rootfs');
  await Bun.write(buildImagePaths(ctx.dataDir, baseImage.digest).config, '{"User":"dev"}');

  await createImage(ctx.db, baseImage);

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  const image = await ctx.impd.templates.createTemplate('dev', 'tools');

  expect(readFile(buildImagePaths(ctx.dataDir, image.digest).config, 'utf8')).resolves.toBe(
    '{"User":"dev"}',
  );
});

test('it wakes a sleeping imp and freezes it before the clone', async () => {
  const ctx = await setupTest();

  const baseImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, baseImage.digest).rootfs, 'rootfs');

  await createImage(ctx.db, baseImage);

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });
  await ctx.impd.imps.sleepImp('dev');

  const before = ctx.events.length;

  await ctx.impd.templates.createTemplate('dev', 'woken');

  expect(ctx.fake.wakes).toHaveLength(1);
  expect(ctx.events[before]).toBe('freeze');
});

test('it clones a stopped imp without a freeze', async () => {
  const ctx = await setupTest();

  const baseImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, baseImage.digest).rootfs, 'rootfs');

  await createImage(ctx.db, baseImage);

  const dev = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  await ctx.impd.imps.stopImp('dev');

  const before = ctx.events.length;

  await ctx.impd.templates.createTemplate('dev', 'cold');

  expect(ctx.events.slice(before)).toStrictEqual([`clone /imps/${dev.id}/disk.ext4`]);
});

test('it refuses a template of an imp that is still being created', async () => {
  const ctx = await setupTest();
  const base = await createImage(ctx.db, buildMockNewImage({ name: 'base' }));

  await createImp(ctx.db, buildMockNewImp({ name: 'dev', imageId: base.id }));

  const creating = ctx.impd.templates.createTemplate('dev', 'tools');

  expect(creating).rejects.toMatchObject({
    code: 'INVALID_STATE',
    message: 'cannot template an imp that is creating (allowed: running, sleeping, stopped, error)',
  });
});

test('it refuses a template of an imp created with backup off, since every backup holds every image', async () => {
  const ctx = await setupTest();

  const baseImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, baseImage.digest).rootfs, 'rootfs');

  await createImage(ctx.db, baseImage);

  await ctx.impd.imps.createImp({ name: 'chat', image: 'base', isBackedUp: false });

  const creating = ctx.impd.templates.createTemplate('chat', 'tools');

  expect(creating).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message:
      'imp chat is left out of backups (created with backup off): a template of it would put its disk in every backup',
  });
});

test('it refuses the builders image name for a template', async () => {
  const ctx = await setupTest();

  const creating = ctx.impd.templates.createTemplate('dev', BUILDER_IMAGE);

  expect(creating).rejects.toMatchObject({
    code: 'CONFLICT',
    message: `the image name ${BUILDER_IMAGE} is impd's, for its image builders; pick another`,
  });
});

test('it gives an imp from a template the template disk', async () => {
  const ctx = await setupTest();

  const baseImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, baseImage.digest).rootfs, 'rootfs');

  await createImage(ctx.db, baseImage);

  const dev = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  await writeFile(buildImpPaths(ctx.dataDir, dev.id).disk, 'golden');

  await ctx.impd.templates.createTemplate('dev', 'tools');

  const copy = await ctx.impd.imps.createImp({ name: 'copy', image: 'tools' });

  expect(readFile(buildImpPaths(ctx.dataDir, copy.id).disk, 'utf8')).resolves.toBe('golden');
});

test('it boots an imp from a template with an identity reset', async () => {
  const ctx = await setupTest();

  const baseImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, baseImage.digest).rootfs, 'rootfs');

  await createImage(ctx.db, baseImage);

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });
  await ctx.impd.templates.createTemplate('dev', 'tools');

  const before = ctx.fake.boots.length;

  await ctx.impd.imps.createImp({ name: 'copy', image: 'tools' });

  expect(ctx.fake.boots.slice(before)).toStrictEqual([{ hostname: 'copy', isIdentityReset: true }]);
});

test('it clears the pending reset once the first boot reports it done', async () => {
  const ctx = await setupTest();

  const baseImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, baseImage.digest).rootfs, 'rootfs');

  await createImage(ctx.db, baseImage);

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });
  await ctx.impd.templates.createTemplate('dev', 'tools');
  await ctx.impd.imps.createImp({ name: 'copy', image: 'tools' });

  const copy = await readImpByName(ctx.db, 'copy');

  expect(copy?.isIdentityResetPending).toBeFalse();
});

test('it boots a template copy without a reset after its first boot', async () => {
  const ctx = await setupTest();

  const baseImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, baseImage.digest).rootfs, 'rootfs');

  await createImage(ctx.db, baseImage);

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });
  await ctx.impd.templates.createTemplate('dev', 'tools');
  await ctx.impd.imps.createImp({ name: 'copy', image: 'tools' });
  await ctx.impd.imps.stopImp('copy');

  const before = ctx.fake.boots.length;

  await ctx.impd.imps.startImp('copy');

  expect(ctx.fake.boots.slice(before)).toStrictEqual([
    { hostname: 'copy', isIdentityReset: false },
  ]);
});

test('it boots an imp from a docker image without a reset', async () => {
  const ctx = await setupTest();

  const baseImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, baseImage.digest).rootfs, 'rootfs');

  await createImage(ctx.db, baseImage);

  await ctx.impd.imps.createImp({ name: 'plain', image: 'base' });

  expect(ctx.fake.boots).toStrictEqual([{ hostname: 'plain', isIdentityReset: false }]);
});

test('it marks a template copy made stopped as owing the reset', async () => {
  const ctx = await setupTest();

  const baseImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, baseImage.digest).rootfs, 'rootfs');

  await createImage(ctx.db, baseImage);

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });
  await ctx.impd.templates.createTemplate('dev', 'tools');
  await ctx.impd.imps.createImp({ name: 'copy', image: 'tools', start: false });

  const stopped = await readImpByName(ctx.db, 'copy');

  expect(stopped?.isIdentityResetPending).toBeTrue();
});

test('it resets a template copy made stopped on its first boot', async () => {
  const ctx = await setupTest();

  const baseImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, baseImage.digest).rootfs, 'rootfs');

  await createImage(ctx.db, baseImage);

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });
  await ctx.impd.templates.createTemplate('dev', 'tools');
  await ctx.impd.imps.createImp({ name: 'copy', image: 'tools', start: false });

  const before = ctx.fake.boots.length;

  await ctx.impd.imps.startImp('copy');

  expect(ctx.fake.boots.slice(before)).toStrictEqual([{ hostname: 'copy', isIdentityReset: true }]);
});

test('it moves a template made again to a new disk under the same image and drops the old disk', async () => {
  const ctx = await setupTest();

  const baseImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, baseImage.digest).rootfs, 'rootfs');

  await createImage(ctx.db, baseImage);

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  const first = await ctx.impd.templates.createTemplate('dev', 'tools');
  const second = await ctx.impd.templates.createTemplate('dev', 'tools');

  expect(second.id).toBe(first.id);
  expect(second.digest).not.toBe(first.digest);
  expect(existsSync(buildImagePaths(ctx.dataDir, first.digest).directory)).toBeFalse();
});

test('it makes an old template again when an eviction runs during the clone', async () => {
  const ctx = await setupTest({ isStorageFull: true });

  const baseImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, baseImage.digest).rootfs, 'rootfs');

  await createImage(ctx.db, baseImage);

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  const first = await ctx.impd.templates.createTemplate('dev', 'tools');

  await ctx.db
    .updateTable('images')
    .set({ last_used_at: Date.parse('2026-08-01T00:00:00Z') })
    .where('name', '=', 'tools')
    .execute();

  ctx.clones.after = () => ctx.images.runImageEviction();

  const second = await ctx.impd.templates.createTemplate('dev', 'tools');
  const stored = await readImageByName(ctx.db, 'tools');

  expect(second.id).toBe(first.id);
  expect(stored?.digest).toBe(second.digest);
});

test('it evicts an old unused image after it makes a template while storage is full', async () => {
  const ctx = await setupTest({ isStorageFull: true });

  const baseImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });
  const oldImage = buildMockNewImage({ name: 'web-2222222', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, baseImage.digest).rootfs, 'rootfs');
  await Bun.write(buildImagePaths(ctx.dataDir, oldImage.digest).rootfs, 'rootfs');

  await createImage(ctx.db, baseImage);
  await createImage(ctx.db, oldImage);

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  await ctx.db
    .updateTable('images')
    .set({ last_used_at: Date.parse('2026-08-01T00:00:00Z') })
    .where('name', '=', 'web-2222222')
    .execute();

  await ctx.impd.templates.createTemplate('dev', 'tools');

  const old = await readImageByName(ctx.db, 'web-2222222');

  expect(old).toBeUndefined();
});

test('it gives imps made after a template is made again its new disk, and older imps keep theirs', async () => {
  const ctx = await setupTest();

  const baseImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, baseImage.digest).rootfs, 'rootfs');

  await createImage(ctx.db, baseImage);

  const dev = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  await writeFile(buildImpPaths(ctx.dataDir, dev.id).disk, 'v1');

  await ctx.impd.templates.createTemplate('dev', 'tools');

  const old = await ctx.impd.imps.createImp({ name: 'old', image: 'tools' });

  await writeFile(buildImpPaths(ctx.dataDir, dev.id).disk, 'v2');

  await ctx.impd.templates.createTemplate('dev', 'tools');

  const made = await ctx.impd.imps.createImp({ name: 'new', image: 'tools' });
  const oldDisk = await readFile(buildImpPaths(ctx.dataDir, old.id).disk, 'utf8');
  const newDisk = await readFile(buildImpPaths(ctx.dataDir, made.id).disk, 'utf8');

  expect(oldDisk).toBe('v1');
  expect(newDisk).toBe('v2');
});

test('it refuses a template over the name of a docker image', async () => {
  const ctx = await setupTest();

  const baseImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, baseImage.digest).rootfs, 'rootfs');

  await createImage(ctx.db, baseImage);

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  const creating = ctx.impd.templates.createTemplate('dev', 'base');

  expect(creating).rejects.toMatchObject({
    code: 'CONFLICT',
    message: 'image base is a docker image; give the template a name of its own',
  });
});

test('it refuses a docker image add over the name of a template', async () => {
  const ctx = await setupTest();

  const baseImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, baseImage.digest).rootfs, 'rootfs');

  await createImage(ctx.db, baseImage);

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });
  await ctx.impd.templates.createTemplate('dev', 'tools');

  const adding = ctx.impd.images.addImage('ubuntu:24.04', 'tools');

  expect(adding).rejects.toMatchObject({
    code: 'CONFLICT',
    message: 'image tools is a template; make it again from an imp, or pick another name',
  });
});

test('it refuses an imp disk smaller than its template disk', async () => {
  const ctx = await setupTest();

  const baseImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, baseImage.digest).rootfs, 'rootfs');

  await createImage(ctx.db, baseImage);

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base', diskMib: 64 });
  await ctx.impd.templates.createTemplate('dev', 'tools');

  const creating = ctx.impd.imps.createImp({ name: 'small', image: 'tools', diskMib: 32 });

  expect(creating).rejects.toMatchObject({
    message: "a disk of 32.0 MiB is smaller than template tools's disk (64.0 MiB)",
  });
});

test('it gives an imp from a template at least the template disk size', async () => {
  const ctx = await setupTest();

  const baseImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, baseImage.digest).rootfs, 'rootfs');

  await createImage(ctx.db, baseImage);

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base', diskMib: 64 });
  await ctx.impd.templates.createTemplate('dev', 'tools');

  const sized = await ctx.impd.imps.createImp({ name: 'sized', image: 'tools' });

  expect(sized.diskMib).toBe(64);
});

test('it refuses to remove a template an imp uses', async () => {
  const ctx = await setupTest();

  const baseImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, baseImage.digest).rootfs, 'rootfs');

  await createImage(ctx.db, baseImage);

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });
  await ctx.impd.templates.createTemplate('dev', 'tools');
  await ctx.impd.imps.createImp({ name: 'copy', image: 'tools' });

  const removing = ctx.impd.images.removeImage('tools');

  expect(removing).rejects.toMatchObject({
    code: 'CONFLICT',
    message: 'image tools is used by 1 imp(s)',
  });
});

test('it removes a template no imp uses, and its disk', async () => {
  const ctx = await setupTest();

  const baseImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, baseImage.digest).rootfs, 'rootfs');

  await createImage(ctx.db, baseImage);

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  const image = await ctx.impd.templates.createTemplate('dev', 'tools');

  await ctx.impd.images.removeImage('tools');

  expect(existsSync(buildImagePaths(ctx.dataDir, image.digest).directory)).toBeFalse();
});

test('it resets a fork of a template copy that never booted', async () => {
  const ctx = await setupTest();

  const baseImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, baseImage.digest).rootfs, 'rootfs');

  await createImage(ctx.db, baseImage);

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });
  await ctx.impd.templates.createTemplate('dev', 'tools');
  await ctx.impd.imps.createImp({ name: 'copy', image: 'tools', start: false });

  const before = ctx.fake.boots.length;

  await ctx.impd.checkpoints.forkImp({ source: 'copy', name: 'fork' });

  expect(ctx.fake.boots.slice(before)).toStrictEqual([{ hostname: 'fork', isIdentityReset: true }]);
});

test('it boots a fork of a booted template copy without a reset', async () => {
  const ctx = await setupTest();

  const baseImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, baseImage.digest).rootfs, 'rootfs');

  await createImage(ctx.db, baseImage);

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });
  await ctx.impd.templates.createTemplate('dev', 'tools');
  await ctx.impd.imps.createImp({ name: 'copy', image: 'tools' });

  const before = ctx.fake.boots.length;

  await ctx.impd.checkpoints.forkImp({ source: 'copy', name: 'later' });

  expect(ctx.fake.boots.slice(before)).toStrictEqual([
    { hostname: 'later', isIdentityReset: false },
  ]);
});

test('it keeps the reset pending when the boot reports it failed', async () => {
  const ctx = await setupTest();

  const baseImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, baseImage.digest).rootfs, 'rootfs');

  await createImage(ctx.db, baseImage);

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });
  await ctx.impd.templates.createTemplate('dev', 'tools');

  ctx.fake.setIdentityReset('failed');

  await ctx.impd.imps.createImp({ name: 'copy', image: 'tools' });

  const copy = await readImpByName(ctx.db, 'copy');

  expect(copy?.isIdentityResetPending).toBeTrue();
});

test('it keeps the reset pending when a boot reports nothing of it', async () => {
  const ctx = await setupTest();

  const baseImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, baseImage.digest).rootfs, 'rootfs');

  await createImage(ctx.db, baseImage);

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });
  await ctx.impd.templates.createTemplate('dev', 'tools');

  ctx.fake.setIdentityReset('failed');

  await ctx.impd.imps.createImp({ name: 'copy', image: 'tools' });
  await ctx.impd.imps.stopImp('copy');

  ctx.fake.setIdentityReset(undefined);

  await ctx.impd.imps.startImp('copy');

  const copy = await readImpByName(ctx.db, 'copy');

  expect(copy?.isIdentityResetPending).toBeTrue();
});

test('it clears a pending reset once a later boot reports it done', async () => {
  const ctx = await setupTest();

  const baseImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, baseImage.digest).rootfs, 'rootfs');

  await createImage(ctx.db, baseImage);

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });
  await ctx.impd.templates.createTemplate('dev', 'tools');

  ctx.fake.setIdentityReset('failed');

  await ctx.impd.imps.createImp({ name: 'copy', image: 'tools' });
  await ctx.impd.imps.stopImp('copy');

  ctx.fake.setIdentityReset('ok');

  await ctx.impd.imps.startImp('copy');

  const copy = await readImpByName(ctx.db, 'copy');

  expect(copy?.isIdentityResetPending).toBeFalse();
});

test('it thaws an imp whose clone fails while it is frozen', async () => {
  const ctx = await setupTest();

  const baseImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, baseImage.digest).rootfs, 'rootfs');

  await createImage(ctx.db, baseImage);

  const dev = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  await rm(buildImpPaths(ctx.dataDir, dev.id).disk);

  const before = ctx.events.length;
  const creating = ctx.impd.templates.createTemplate('dev', 'tools');

  await creating.catch(() => {});

  expect(creating).rejects.toMatchObject({ code: 'ENOENT' });
  expect(ctx.events.slice(before)).toStrictEqual(['freeze', 'thaw']);
});

test('it leaves no template image when the clone fails', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'base', digest: 'sha256:base', sizeBytes: 6 }),
  );

  const dev = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  await rm(buildImpPaths(ctx.dataDir, dev.id).disk);

  const creating = ctx.impd.templates.createTemplate('dev', 'tools');

  await creating.catch(() => {});

  const tools = await readImageByName(ctx.db, 'tools');

  expect(creating).rejects.toMatchObject({ code: 'ENOENT' });
  expect(tools).toBeUndefined();
  expect(readdirSync(join(ctx.dataDir, 'images'))).toStrictEqual(['base']);
});

test('it fails with the clone error when the clone fails', async () => {
  const ctx = await setupTest();

  const baseImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, baseImage.digest).rootfs, 'rootfs');

  await createImage(ctx.db, baseImage);

  const dev = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  await rm(buildImpPaths(ctx.dataDir, dev.id).disk);

  const creating = ctx.impd.templates.createTemplate('dev', 'tools');

  expect(creating).rejects.toMatchObject({ code: 'ENOENT' });
});

test('it removes the cloned disk and rethrows when the image row fails to write', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'base', digest: 'sha256:base', sizeBytes: 6 }),
  );

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  await runSql(
    ctx.db,
    `CREATE TRIGGER refuse_templates BEFORE INSERT ON images WHEN NEW.source = 'imp'
    BEGIN SELECT RAISE(ABORT, 'template rows refused'); END`,
  );

  const creating = ctx.impd.templates.createTemplate('dev', 'tools');

  expect(creating).rejects.toThrowWithMessage(Error, /template rows refused/u);
  expect(readdirSync(join(ctx.dataDir, 'images'))).toStrictEqual(['base']);
});
