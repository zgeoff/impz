import { expect, onTestFinished, test } from 'bun:test';
import { closeSync, fsyncSync, openSync, statfsSync, writeSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { startDiskSampler } from './start-disk-sampler';

// The sampler waits for free space to hold still, which /dev/shm never does while another process
// writes there, so these need the small filesystem of their own that IMP_TEST_SMALL_FS names,
// which CI mounts as a loop XFS, and skip without it.
async function setupTest() {
  const mount = await mkdtemp(join(process.env['IMP_TEST_SMALL_FS'] ?? '', 'disk-sampler-'));

  onTestFinished(() => rm(mount, { recursive: true, force: true }));

  return { mount };
}

test.skipIf(process.env['IMP_TEST_SMALL_FS'] === undefined)(
  'it reports a run that resolves as built on a small filesystem',
  async () => {
    const ctx = await setupTest();
    const sampler = await startDiskSampler(ctx.mount);
    const trial = await sampler.measure(() => Promise.resolve());

    expect(trial.outcome).toBe('built');
  },
);

test.skipIf(process.env['IMP_TEST_SMALL_FS'] === undefined)(
  'it reports a run that rejects with a code by its code on a small filesystem',
  async () => {
    const ctx = await setupTest();
    const sampler = await startDiskSampler(ctx.mount);

    const trial = await sampler.measure(() =>
      Promise.reject(Object.assign(new Error('full'), { code: 'DISK_FULL' })),
    );

    expect(trial.outcome).toBe('DISK_FULL');
  },
);

test.skipIf(process.env['IMP_TEST_SMALL_FS'] === undefined)(
  'it reports a run that rejects with no code by its text on a small filesystem',
  async () => {
    const ctx = await setupTest();
    const sampler = await startDiskSampler(ctx.mount);
    const trial = await sampler.measure(() => Promise.reject(new Error('the build failed')));

    expect(trial.outcome).toBe('Error: the build failed');
  },
);

test.skipIf(process.env['IMP_TEST_SMALL_FS'] === undefined)(
  'it reports no settled use for a run that never marks its write on a small filesystem',
  async () => {
    const ctx = await setupTest();
    const sampler = await startDiskSampler(ctx.mount);
    const trial = await sampler.measure(() => Promise.resolve());

    expect(trial.settledBytes).toBe(0);
  },
);

test.skipIf(process.env['IMP_TEST_SMALL_FS'] === undefined)(
  'it sees the peak use of a file a run writes and removes on a small filesystem',
  async () => {
    const ctx = await setupTest();
    const sampler = await startDiskSampler(ctx.mount);

    const trial = await sampler.measure(async () => {
      const file = join(ctx.mount, 'big');
      const fd = openSync(file, 'w');

      writeSync(fd, new Uint8Array(32 * 1024 ** 2).fill(1));
      fsyncSync(fd);
      closeSync(fd);

      sampler.markWritten();

      await rm(file);
    });

    expect(trial.peakBytes).toBeGreaterThanOrEqual(16 * 1024 ** 2);
  },
);

test.skipIf(process.env['IMP_TEST_SMALL_FS'] === undefined)(
  'it reads the settled use at the moment the run marks its write on a small filesystem',
  async () => {
    const ctx = await setupTest();
    const sampler = await startDiskSampler(ctx.mount);

    const trial = await sampler.measure(async () => {
      const file = join(ctx.mount, 'big');
      const fd = openSync(file, 'w');

      writeSync(fd, new Uint8Array(32 * 1024 ** 2).fill(1));
      fsyncSync(fd);
      closeSync(fd);

      sampler.markWritten();

      await rm(file);
    });

    expect(trial.settledBytes).toBeGreaterThanOrEqual(16 * 1024 ** 2);
  },
);

test.skipIf(process.env['IMP_TEST_SMALL_FS'] === undefined)(
  'it refuses a fill when less than the room is free above the reserve on a small filesystem',
  async () => {
    const ctx = await setupTest();
    const sampler = await startDiskSampler(ctx.mount);

    const stats = statfsSync(ctx.mount);

    expect(sampler.fill(1024, stats.bavail * stats.bsize)).rejects.toThrow(
      'B free above the reserve',
    );
  },
);

test.skipIf(process.env['IMP_TEST_SMALL_FS'] === undefined)(
  'it refuses a fill over a file it did not make, and keeps that file, on a small filesystem',
  async () => {
    const ctx = await setupTest();

    const taken = join(ctx.mount, 'taken');

    await Bun.write(taken, 'not the sampler’s');

    const sampler = await startDiskSampler(ctx.mount, taken);

    const stats = statfsSync(ctx.mount);
    const filling = sampler.fill(1024 ** 2, stats.bavail * stats.bsize - 64 * 1024 ** 2);

    await filling.catch(() => {});

    expect(filling).rejects.toThrowWithMessage(
      Error,
      `${taken} is there already, and not the sampler's`,
    );

    const kept = await Bun.file(taken).text();

    expect(kept).toBe('not the sampler’s');
  },
);

test.skipIf(process.env['IMP_TEST_SMALL_FS'] === undefined)(
  'it fails a fill whose fallocate fails, with its stderr, on a small filesystem',
  async () => {
    const ctx = await setupTest();
    const sampler = await startDiskSampler(ctx.mount, join(ctx.mount, 'missing', 'filler'));

    const stats = statfsSync(ctx.mount);

    expect(
      sampler.fill(1024 ** 2, stats.bavail * stats.bsize - 64 * 1024 ** 2),
    ).rejects.toThrowWithMessage(
      Error,
      /^fallocate failed: fallocate: cannot open .*No such file or directory/v,
    );
  },
);

test.skipIf(process.env['IMP_TEST_SMALL_FS'] === undefined)(
  'it removes its filler when the test ends on a small filesystem',
  async () => {
    const ctx = await setupTest();

    const fillers = await mkdtemp(
      join(process.env['IMP_TEST_SMALL_FS'] ?? '', 'disk-sampler-fillers-'),
    );

    const sampler = await startDiskSampler(ctx.mount, join(fillers, 'filler'));

    const stats = statfsSync(ctx.mount);

    await sampler.fill(1024 ** 2, stats.bavail * stats.bsize - 8 * 1024 ** 2);

    // In Bun a hook that throws skips the hooks after it, so one hook
    // reads, removes the directory, then checks, and never leaks it.
    onTestFinished(async () => {
      const left = await readdir(fillers);

      await rm(fillers, { recursive: true, force: true });

      expect(left).toStrictEqual([]);
    });
  },
);
