import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  countUnsharedMib,
  parseProcFields,
  readCpuTicks,
  readHugetlbMibAsync,
  readOwnedRamMib,
  readOwnedRamMibAsync,
  readResidentMibAsync,
  readRssMib,
  readUnsharedRamMib,
  readVmMemory,
} from './vm-stats';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-vm-stats-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const procRoot = join(directory, 'proc');

  mkdirSync(procRoot);

  return { procRoot };
}

test('#parseProcFields reads the kB fields of smaps_rollup', () => {
  const fields = parseProcFields(
    [
      '7f0000000000-7fffffffffff ---p 00000000 00:00 0                          [rollup]',
      'Rss:              349184 kB',
      'Pss_Anon:          15360 kB',
      'Private_Dirty:     15400 kB',
      'THPeligible:    0',
    ].join('\n'),
  );

  expect([...fields]).toStrictEqual([
    ['Rss', 349_184],
    ['Pss_Anon', 15_360],
    ['Private_Dirty', 15_400],
  ]);
});

test('#countUnsharedMib counts anonymous and shmem pages in full, in MiB', () => {
  expect(
    countUnsharedMib(
      new Map([
        ['Anonymous', 2048],
        ['Pss_Anon', 512],
        ['Pss_Shmem', 1024],
      ]),
    ),
  ).toBe(3);
});

test('#readOwnedRamMib counts the anonymous and shmem Pss of a live firecracker', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, '42'));
  writeFileSync(join(ctx.procRoot, '42', 'stat'), '42 (firecracker) S 1 42 42 0 -1');
  writeFileSync(join(ctx.procRoot, '42', 'cmdline'), 'firecracker\0--api-sock\0/run/api.sock\0');

  writeFileSync(
    join(ctx.procRoot, '42', 'status'),
    'Name:\tfirecracker\nHugetlbPages:\t       0 kB\n',
  );

  writeFileSync(
    join(ctx.procRoot, '42', 'smaps_rollup'),
    'Rss:              409600 kB\nPss_Anon:          204800 kB\nPss_Shmem:          51200 kB\nAnonymous:         307200 kB\n',
  );

  expect(readOwnedRamMib(42, '/run/api.sock', ctx.procRoot)).toBe(250);
});

test('#readOwnedRamMibAsync counts what readOwnedRamMib counts', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, '42'));
  writeFileSync(join(ctx.procRoot, '42', 'stat'), '42 (firecracker) S 1 42 42 0 -1');
  writeFileSync(join(ctx.procRoot, '42', 'cmdline'), 'firecracker\0--api-sock\0/run/api.sock\0');

  writeFileSync(
    join(ctx.procRoot, '42', 'status'),
    'Name:\tfirecracker\nHugetlbPages:\t       0 kB\n',
  );

  writeFileSync(
    join(ctx.procRoot, '42', 'smaps_rollup'),
    'Rss:              409600 kB\nPss_Anon:          204800 kB\nPss_Shmem:          51200 kB\n',
  );

  const ramMib = await readOwnedRamMibAsync(42, '/run/api.sock', ctx.procRoot);

  expect(ramMib).toBe(250);
});

test('#readResidentMibAsync counts the resident anonymous and shmem pages of a live firecracker', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, '42'));
  writeFileSync(join(ctx.procRoot, '42', 'stat'), '42 (firecracker) S 1 42 42 0 -1');
  writeFileSync(join(ctx.procRoot, '42', 'cmdline'), 'firecracker\0--api-sock\0/run/api.sock\0');

  writeFileSync(
    join(ctx.procRoot, '42', 'status'),
    'Name:\tfirecracker\nHugetlbPages:\t       0 kB\n',
  );

  writeFileSync(
    join(ctx.procRoot, '42', 'status'),
    'Name:\tfirecracker\nVmRSS:\t  471040 kB\nRssAnon:\t  307200 kB\nRssFile:\t  102400 kB\nRssShmem:\t   61440 kB\nThreads:\t5\n',
  );

  const residentMib = await readResidentMibAsync(42, '/run/api.sock', ctx.procRoot);

  expect(residentMib).toBe(360);
});

test('#readResidentMibAsync counts the hugetlb pages of a firecracker on 2 MiB pages', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, '42'));
  writeFileSync(join(ctx.procRoot, '42', 'stat'), '42 (firecracker) S 1 42 42 0 -1');
  writeFileSync(join(ctx.procRoot, '42', 'cmdline'), 'firecracker\0--api-sock\0/run/api.sock\0');

  writeFileSync(
    join(ctx.procRoot, '42', 'status'),
    'Name:\tfirecracker\nRssAnon:\t   20480 kB\nRssFile:\t  102400 kB\nRssShmem:\t       0 kB\nHugetlbPages:\t   75776 kB\n',
  );

  const residentMib = await readResidentMibAsync(42, '/run/api.sock', ctx.procRoot);

  expect(residentMib).toBe(94);
});

test("#readOwnedRamMibAsync counts a 2 MiB guest's memory as its HugetlbPages", async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, '42'));
  writeFileSync(join(ctx.procRoot, '42', 'stat'), '42 (firecracker) S 1 42 42 0 -1');
  writeFileSync(join(ctx.procRoot, '42', 'cmdline'), 'firecracker\0--api-sock\0/run/api.sock\0');

  writeFileSync(
    join(ctx.procRoot, '42', 'smaps_rollup'),
    'Rss:               40960 kB\nPss_Anon:              0 kB\nPss_Shmem:             0 kB\nPrivate_Hugetlb:   75776 kB\n',
  );

  writeFileSync(
    join(ctx.procRoot, '42', 'status'),
    'Name:\tfirecracker\nRssAnon:\t       0 kB\nHugetlbPages:\t   75776 kB\n',
  );

  const ramMib = await readOwnedRamMibAsync(42, '/run/api.sock', ctx.procRoot);

  expect(ramMib).toBe(74);
});

test("#readUnsharedRamMib counts a 2 MiB guest's hugetlb pages for its next wake", () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, '42'));
  writeFileSync(join(ctx.procRoot, '42', 'stat'), '42 (firecracker) S 1 42 42 0 -1');
  writeFileSync(join(ctx.procRoot, '42', 'cmdline'), 'firecracker\0--api-sock\0/run/api.sock\0');
  writeFileSync(join(ctx.procRoot, '42', 'smaps_rollup'), 'Anonymous:          10240 kB\n');
  writeFileSync(join(ctx.procRoot, '42', 'status'), 'HugetlbPages:\t   71680 kB\n');

  expect(readUnsharedRamMib(42, '/run/api.sock', ctx.procRoot)).toBe(80);
});

test('#readHugetlbMibAsync reads the pool pages a firecracker holds', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, '42'));
  writeFileSync(join(ctx.procRoot, '42', 'stat'), '42 (firecracker) S 1 42 42 0 -1');
  writeFileSync(join(ctx.procRoot, '42', 'cmdline'), 'firecracker\0--api-sock\0/run/api.sock\0');

  writeFileSync(
    join(ctx.procRoot, '42', 'status'),
    'RssAnon:\t   20480 kB\nHugetlbPages:\t   71680 kB\n',
  );

  const hugetlbMib = await readHugetlbMibAsync(42, '/run/api.sock', ctx.procRoot);

  expect(hugetlbMib).toBe(70);
});

test('#readHugetlbMibAsync reads nothing for a pid that is gone', async () => {
  const ctx = setupTest();

  const hugetlbMib = await readHugetlbMibAsync(42, '/run/api.sock', ctx.procRoot);

  expect(hugetlbMib).toBeNull();
});

test('#readResidentMibAsync reads nothing for a pid that serves another socket', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, '42'));
  writeFileSync(join(ctx.procRoot, '42', 'stat'), '42 (firecracker) S 1 42 42 0 -1');
  writeFileSync(join(ctx.procRoot, '42', 'cmdline'), 'firecracker\0--api-sock\0/run/other.sock\0');
  writeFileSync(join(ctx.procRoot, '42', 'status'), 'RssAnon:\t  307200 kB\n');

  const residentMib = await readResidentMibAsync(42, '/run/api.sock', ctx.procRoot);

  expect(residentMib).toBeNull();
});

test('#readOwnedRamMibAsync reads nothing for a pid that serves another socket', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, '42'));
  writeFileSync(join(ctx.procRoot, '42', 'stat'), '42 (firecracker) S 1 42 42 0 -1');
  writeFileSync(join(ctx.procRoot, '42', 'cmdline'), 'firecracker\0--api-sock\0/run/other.sock\0');
  writeFileSync(join(ctx.procRoot, '42', 'smaps_rollup'), 'Pss_Anon:          204800 kB\n');

  const ramMib = await readOwnedRamMibAsync(42, '/run/api.sock', ctx.procRoot);

  expect(ramMib).toBeNull();
});

test('#readOwnedRamMibAsync reads nothing for a firecracker without smaps_rollup', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, '42'));
  writeFileSync(join(ctx.procRoot, '42', 'stat'), '42 (firecracker) S 1 42 42 0 -1');
  writeFileSync(join(ctx.procRoot, '42', 'cmdline'), 'firecracker\0--api-sock\0/run/api.sock\0');

  writeFileSync(
    join(ctx.procRoot, '42', 'status'),
    'Name:\tfirecracker\nHugetlbPages:\t       0 kB\n',
  );

  const ramMib = await readOwnedRamMibAsync(42, '/run/api.sock', ctx.procRoot);

  expect(ramMib).toBeNull();
});

test('#readUnsharedRamMib counts the anonymous pages in full and the shmem Pss', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, '42'));
  writeFileSync(join(ctx.procRoot, '42', 'stat'), '42 (firecracker) S 1 42 42 0 -1');
  writeFileSync(join(ctx.procRoot, '42', 'cmdline'), 'firecracker\0--api-sock\0/run/api.sock\0');

  writeFileSync(
    join(ctx.procRoot, '42', 'status'),
    'Name:\tfirecracker\nHugetlbPages:\t       0 kB\n',
  );

  writeFileSync(
    join(ctx.procRoot, '42', 'smaps_rollup'),
    'Rss:              409600 kB\nPss_Anon:          204800 kB\nPss_Shmem:          51200 kB\nAnonymous:         307200 kB\n',
  );

  expect(readUnsharedRamMib(42, '/run/api.sock', ctx.procRoot)).toBe(350);
});

test('#readRssMib reads the resident size of a live firecracker', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, '42'));
  writeFileSync(join(ctx.procRoot, '42', 'stat'), '42 (firecracker) S 1 42 42 0 -1');
  writeFileSync(join(ctx.procRoot, '42', 'cmdline'), 'firecracker\0--api-sock\0/run/api.sock\0');

  writeFileSync(
    join(ctx.procRoot, '42', 'status'),
    'Name:\tfirecracker\nHugetlbPages:\t       0 kB\n',
  );

  writeFileSync(
    join(ctx.procRoot, '42', 'smaps_rollup'),
    'Rss:              409600 kB\nPss_Anon:          204800 kB\nPss_Shmem:          51200 kB\nAnonymous:         307200 kB\n',
  );

  expect(readRssMib(42, '/run/api.sock', ctx.procRoot)).toBe(400);
});

test('#readVmMemory reads the counted and the resident size in one read', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, '42'));
  writeFileSync(join(ctx.procRoot, '42', 'stat'), '42 (firecracker) S 1 42 42 0 -1');
  writeFileSync(join(ctx.procRoot, '42', 'cmdline'), 'firecracker\0--api-sock\0/run/api.sock\0');

  writeFileSync(
    join(ctx.procRoot, '42', 'status'),
    'Name:\tfirecracker\nHugetlbPages:\t       0 kB\n',
  );

  writeFileSync(
    join(ctx.procRoot, '42', 'smaps_rollup'),
    'Rss:              409600 kB\nPss_Anon:          204800 kB\nPss_Shmem:          51200 kB\nAnonymous:         307200 kB\n',
  );

  expect(readVmMemory(42, '/run/api.sock', ctx.procRoot)).toStrictEqual({
    ramMib: 250,
    rssMib: 400,
  });
});

test('#readOwnedRamMib rounds to whole MiB', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, '42'));
  writeFileSync(join(ctx.procRoot, '42', 'stat'), '42 (firecracker) S 1 42 42 0 -1');
  writeFileSync(join(ctx.procRoot, '42', 'cmdline'), 'firecracker\0--api-sock\0/run/api.sock\0');

  writeFileSync(
    join(ctx.procRoot, '42', 'status'),
    'Name:\tfirecracker\nHugetlbPages:\t       0 kB\n',
  );

  writeFileSync(join(ctx.procRoot, '42', 'smaps_rollup'), 'Pss_Anon:            1600 kB\n');

  expect(readOwnedRamMib(42, '/run/api.sock', ctx.procRoot)).toBe(2);
});

test('#readOwnedRamMib reads nothing for a pid that serves another socket', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, '42'));
  writeFileSync(join(ctx.procRoot, '42', 'stat'), '42 (firecracker) S 1 42 42 0 -1');
  writeFileSync(join(ctx.procRoot, '42', 'cmdline'), 'firecracker\0--api-sock\0/run/other.sock\0');
  writeFileSync(join(ctx.procRoot, '42', 'smaps_rollup'), 'Pss_Anon:          204800 kB\n');

  expect(readOwnedRamMib(42, '/run/api.sock', ctx.procRoot)).toBeNull();
});

test('#readOwnedRamMib reads nothing for a zombie firecracker', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, '42'));
  writeFileSync(join(ctx.procRoot, '42', 'stat'), '42 (firecracker) Z 1 42 42 0 -1');
  writeFileSync(join(ctx.procRoot, '42', 'cmdline'), 'firecracker\0--api-sock\0/run/api.sock\0');

  writeFileSync(
    join(ctx.procRoot, '42', 'status'),
    'Name:\tfirecracker\nHugetlbPages:\t       0 kB\n',
  );

  writeFileSync(join(ctx.procRoot, '42', 'smaps_rollup'), 'Pss_Anon:          204800 kB\n');

  expect(readOwnedRamMib(42, '/run/api.sock', ctx.procRoot)).toBeNull();
});

test('#readRssMib reads nothing for a firecracker without smaps_rollup', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, '42'));
  writeFileSync(join(ctx.procRoot, '42', 'stat'), '42 (firecracker) S 1 42 42 0 -1');
  writeFileSync(join(ctx.procRoot, '42', 'cmdline'), 'firecracker\0--api-sock\0/run/api.sock\0');

  writeFileSync(
    join(ctx.procRoot, '42', 'status'),
    'Name:\tfirecracker\nHugetlbPages:\t       0 kB\n',
  );

  expect(readRssMib(42, '/run/api.sock', ctx.procRoot)).toBeNull();
});

test('#readVmMemory reads nothing for a pid that is gone', () => {
  const ctx = setupTest();

  expect(readVmMemory(42, '/run/api.sock', ctx.procRoot)).toStrictEqual({
    ramMib: null,
    rssMib: null,
  });
});

test('#readUnsharedRamMib reads nothing for a pid that is gone', () => {
  const ctx = setupTest();

  expect(readUnsharedRamMib(42, '/run/api.sock', ctx.procRoot)).toBeNull();
});

test('#readCpuTicks adds the user and system ticks of stat', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, '42'));

  writeFileSync(
    join(ctx.procRoot, '42', 'stat'),
    '42 (firecracker) S 1 42 42 0 -1 4194560 100 0 0 0 1500 250 0 0 20 0 3 0',
  );

  expect(readCpuTicks(42, ctx.procRoot)).toBe(1750);
});

test('#readCpuTicks reads past a command name with spaces and parentheses', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, '42'));

  writeFileSync(
    join(ctx.procRoot, '42', 'stat'),
    '42 (fc (vm) 1) S 1 42 42 0 -1 4194560 100 0 0 0 1500 250 0 0 20 0 3 0',
  );

  expect(readCpuTicks(42, ctx.procRoot)).toBe(1750);
});

test('#readCpuTicks reads nothing for a process that is gone', () => {
  const ctx = setupTest();

  expect(readCpuTicks(42, ctx.procRoot)).toBeNull();
});

test('#readCpuTicks reads the host /proc by default', () => {
  expect(readCpuTicks(process.pid)).toSatisfy(Number.isSafeInteger);
});
