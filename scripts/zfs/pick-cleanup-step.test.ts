import { expect, test } from 'bun:test';
import { pickCleanupStep } from './pick-cleanup-step.ts';

test.each([
  [
    'a read of its own pool’s use of the file first',
    { prefix: 'zfs-host-test', pool: 'impbench7', vdev: '/w/bench.img', status: 0 },
    { action: 'read-own-use' },
  ],
  [
    'a destroy when its own pool uses the file',
    { prefix: 'zfs-host-test', pool: 'impbench7', vdev: '/w/bench.img', status: 0, ownUse: 'used' },
    { action: 'destroy' },
  ],
  [
    'a read of any pool’s use of the file when its own pool does not use it',
    {
      prefix: 'zfs-host-test',
      pool: 'impbench7',
      vdev: '/w/bench.img',
      status: 0,
      ownUse: 'unused',
    },
    { action: 'read-any-use' },
  ],
  [
    'a read of any pool’s use of the file when zpool cannot say what its own pool uses',
    {
      prefix: 'zfs-host-test',
      pool: 'impbench7',
      vdev: '/w/bench.img',
      status: 0,
      ownUse: 'unknown',
    },
    { action: 'read-any-use' },
  ],
  [
    'a read of any pool’s use of the file once the destroy succeeds',
    {
      prefix: 'zfs-host-test',
      pool: 'impbench7',
      vdev: '/w/bench.img',
      status: 0,
      ownUse: 'used',
      destroyed: { exitCode: 0, output: '' },
    },
    { action: 'read-any-use' },
  ],
  [
    'a read of the kernel oops when the destroy finds the pool busy',
    {
      prefix: 'zfs-host-test',
      pool: 'impbench7',
      vdev: '/w/bench.img',
      status: 0,
      ownUse: 'used',
      destroyed: { exitCode: 1, output: "cannot destroy 'impbench7': pool is busy\n" },
    },
    { action: 'read-oops' },
  ],
  [
    'a pass that keeps the file and prints the oops when a ZFS oops holds the busy pool',
    {
      prefix: 'zfs-host-test',
      pool: 'impbench7',
      vdev: '/w/bench.img',
      status: 0,
      ownUse: 'used',
      destroyed: { exitCode: 1, output: "cannot destroy 'impbench7': pool is busy\n" },
      oops: [
        '[  90.200100] kernel BUG at mm/usercopy.c:102!',
        '[  90.200500]  zfs_read+0x3c8/0x500 [zfs]',
      ],
    },
    {
      action: 'finish',
      status: 0,
      stderr: [
        "cannot destroy 'impbench7': pool is busy\n",
        'zfs-host-test: a kernel oops in ZFS holds impbench7 until a reboot; its file stays at /w/bench.img\n[  90.200100] kernel BUG at mm/usercopy.c:102!\n[  90.200500]  zfs_read+0x3c8/0x500 [zfs]\n',
      ],
    },
  ],
  [
    'a failure that keeps the file when the pool is busy with no ZFS oops',
    {
      prefix: 'zfs-host-test',
      pool: 'impbench7',
      vdev: '/w/bench.img',
      status: 0,
      ownUse: 'used',
      destroyed: { exitCode: 1, output: "cannot destroy 'impbench7': pool is busy\n" },
      oops: [],
    },
    {
      action: 'finish',
      status: 1,
      stderr: [
        "cannot destroy 'impbench7': pool is busy\n",
        'zfs-host-test: could not destroy impbench7; its file stays at /w/bench.img\n',
      ],
    },
  ],
  [
    'a failure that keeps the file, saying only that, when a destroy fails with no output',
    {
      prefix: 'zfs-host-test',
      pool: 'impbench7',
      vdev: '/w/bench.img',
      status: 0,
      ownUse: 'used',
      destroyed: { exitCode: 1, output: '' },
    },
    {
      action: 'finish',
      status: 1,
      stderr: ['zfs-host-test: could not destroy impbench7; its file stays at /w/bench.img\n'],
    },
  ],
  [
    'a failure with the suites’ own status when the destroy fails after failed suites',
    {
      prefix: 'zfs-host-test',
      pool: 'impbench7',
      vdev: '/w/bench.img',
      status: 2,
      ownUse: 'used',
      destroyed: { exitCode: 1, output: "cannot open 'impbench7': I/O error\n" },
    },
    {
      action: 'finish',
      status: 2,
      stderr: [
        "cannot open 'impbench7': I/O error\n",
        'zfs-host-test: could not destroy impbench7; its file stays at /w/bench.img\n',
      ],
    },
  ],
  [
    'a failure that keeps the file while a pool still uses it',
    {
      prefix: 'zfs-host-test',
      pool: 'impbench7',
      vdev: '/w/bench.img',
      status: 0,
      ownUse: 'unused',
      anyUse: 'used',
    },
    {
      action: 'finish',
      status: 1,
      stderr: ['zfs-host-test: a pool still uses /w/bench.img; it stays\n'],
    },
  ],
  [
    'a failure that keeps the file when zpool cannot say what uses it',
    {
      prefix: 'zfs-host-test',
      pool: 'impbench7',
      vdev: '/w/bench.img',
      status: 0,
      ownUse: 'unused',
      anyUse: 'unknown',
    },
    {
      action: 'finish',
      status: 1,
      stderr: ['zfs-host-test: zpool cannot say which pools use /w/bench.img; it stays\n'],
    },
  ],
  [
    'a removal of the file once no pool uses it',
    {
      prefix: 'zfs-host-test',
      pool: 'impbench7',
      vdev: '/w/bench.img',
      status: 0,
      ownUse: 'unused',
      anyUse: 'unused',
    },
    { action: 'remove' },
  ],
  [
    'a failure, saying so, when the file will not go',
    {
      prefix: 'zfs-host-test',
      pool: 'impbench7',
      vdev: '/w/bench.img',
      status: 0,
      ownUse: 'unused',
      anyUse: 'unused',
      removed: { exitCode: 1, output: "rm: cannot remove '/w/bench.img': Read-only file system\n" },
    },
    {
      action: 'finish',
      status: 1,
      stderr: [
        "rm: cannot remove '/w/bench.img': Read-only file system\n",
        'zfs-host-test: could not remove /w/bench.img\n',
      ],
    },
  ],
  [
    'the suites’ status once the file is gone',
    {
      prefix: 'zfs-host-test',
      pool: 'impbench7',
      vdev: '/w/bench.img',
      status: 2,
      ownUse: 'used',
      destroyed: { exitCode: 0, output: '' },
      anyUse: 'unused',
      removed: { exitCode: 0, output: '' },
    },
    { action: 'finish', status: 2, stderr: [] },
  ],
] as const)('it picks %s', (_label, facts, step) => {
  expect(pickCleanupStep(facts)).toStrictEqual(step);
});
