import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatShellWord } from '@impz/test-utils/format-shell-word';
import { createStubBin } from '../../scripts/test-utils/create-stub-bin';

// /dev/zfs is a fixed path, so the zfs steps after its check go untested here.
// mknod records into its own file: make_loop_nodes calls it once for each loop
// device this host has.
function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-setup-storage-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  mkdirSync(join(directory, 'data'));

  return {
    directoryPath: directory,
    nodesPath: join(directory, 'nodes'),
    bin: join(directory, 'bin'),
    calls: join(directory, 'calls'),
    root: join(directory, 'imp'),
    file: join(directory, 'data', 'imp.xfs'),
    script: new URL('setup-storage.sh', import.meta.url).pathname,
  };
}

test('it refuses a storage backend other than xfs or zfs', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'mountpoint');

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: { PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`, IMP_STORAGE_BACKEND: 'btrfs' },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'setup-storage: IMP_STORAGE_BACKEND is btrfs; use xfs or zfs\n',
  });

  expect(readFileSync(ctx.calls, 'utf8')).toBe('');
});

test('it refuses the zfs backend without a dataset in IMP_ZFS_ROOT', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'zfs');

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: { PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`, IMP_STORAGE_BACKEND: 'zfs' },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr:
      'setup-storage: IMP_STORAGE_BACKEND=zfs needs IMP_ZFS_ROOT, the dataset for /var/lib/imp\n',
  });

  expect(readFileSync(ctx.calls, 'utf8')).toBe('');
});

test('it refuses to start without a mount at /var/lib/imp when loop files are off', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'mountpoint', 'exit 1');

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: { PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`, IMP_STORAGE_LOOP: '0' },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr:
      'setup-storage: nothing is mounted at /var/lib/imp; mount a host XFS directory with reflink there\n',
  });

  expect(readFileSync(ctx.calls, 'utf8')).toBe('mountpoint -q /var/lib/imp\n');
});

test('it refuses a loop file whose directory is not a mount, since it would go with the container', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'mountpoint', 'exit 1');
  createStubBin(ctx.directoryPath, 'truncate');
  createStubBin(ctx.directoryPath, 'mkfs.xfs');

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: {
      PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`,
      IMP_STORAGE_FILE: join(ctx.directoryPath, 'data', 'imp.xfs'),
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: `setup-storage: ${ctx.directoryPath}/data is not a mount; mount a host directory there for ${ctx.directoryPath}/data/imp.xfs\n`,
  });

  expect(readFileSync(ctx.calls, 'utf8').split('\n')).toStrictEqual([
    'mountpoint -q /var/lib/imp',
    `mountpoint -q ${ctx.directoryPath}/data`,
    '',
  ]);
});

test('it refuses a filesystem already mounted at /var/lib/imp that is not XFS, and leaves it mounted', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'mountpoint');
  createStubBin(ctx.directoryPath, 'findmnt', 'echo ext4');
  createStubBin(ctx.directoryPath, 'umount');

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: { PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'setup-storage: /var/lib/imp already mounted\n',
    stderr: 'setup-storage: /var/lib/imp is ext4; imp needs XFS with reflink\n',
  });

  expect(readFileSync(ctx.calls, 'utf8').split('\n')).toStrictEqual([
    'mountpoint -q /var/lib/imp',
    'findmnt -n -o FSTYPE --mountpoint /var/lib/imp',
    '',
  ]);
});

test('it creates a sparse XFS loop file, mounts it and checks that it reflinks', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'mountpoint', `[ "$2" != ${formatShellWord(ctx.root)} ]`);
  createStubBin(ctx.directoryPath, 'truncate');
  createStubBin(ctx.directoryPath, 'mkfs.xfs');
  createStubBin(ctx.directoryPath, 'losetup', `[ "$1" != -f ] || echo '/dev/loop7777 (lost)'`);
  createStubBin(ctx.directoryPath, 'mount');
  createStubBin(ctx.directoryPath, 'umount');
  createStubBin(ctx.directoryPath, 'findmnt', 'echo xfs');
  createStubBin(ctx.directoryPath, 'cp');
  createStubBin(ctx.nodesPath, 'mknod');

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: {
      PATH: `${join(ctx.nodesPath, 'bin')}:${ctx.bin}:${process.env['PATH'] ?? ''}`,
      IMP_STORAGE_ROOT: ctx.root,
      IMP_STORAGE_FILE: ctx.file,
      IMP_STORAGE_GIB: '8',
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 0,
    stdout: `setup-storage: creating 8 GiB sparse ${ctx.file}\nsetup-storage: mounted ${ctx.file} on ${ctx.root}\n`,
    stderr: '',
  });

  expect(readFileSync(ctx.calls, 'utf8').split('\n')).toStrictEqual([
    `mountpoint -q ${ctx.root}`,
    `mountpoint -q ${ctx.directoryPath}/data`,
    `truncate -s 8G ${ctx.file}`,
    `mkfs.xfs -q -m reflink=1 -i nrext64=0,exchange=0 -n parent=0 ${ctx.file}`,
    `losetup -j ${ctx.file} -n -O NAME`,
    'losetup -f',
    `losetup /dev/loop7777 ${ctx.file}`,
    `mount -o nosuid /dev/loop7777 ${ctx.root}`,
    'losetup -d /dev/loop7777',
    `findmnt -n -o FSTYPE --mountpoint ${ctx.root}`,
    expect.toStartWith(`cp --reflink=always ${ctx.root}/.reflink-probe.`),
    '',
  ]);

  expect(readFileSync(join(ctx.nodesPath, 'calls'), 'utf8')).toInclude(
    'mknod /dev/loop7777 b 7 7777\n',
  );

  expect(readdirSync(ctx.root)).toStrictEqual([]);
});

test('it mounts a loop file that exists already without formatting it again', () => {
  const ctx = setupTest();

  writeFileSync(ctx.file, '');
  createStubBin(ctx.directoryPath, 'mountpoint', `[ "$2" != ${formatShellWord(ctx.root)} ]`);
  createStubBin(ctx.directoryPath, 'truncate');
  createStubBin(ctx.directoryPath, 'mkfs.xfs');
  createStubBin(ctx.directoryPath, 'losetup', `[ "$1" != -f ] || echo '/dev/loop7777 (lost)'`);
  createStubBin(ctx.directoryPath, 'mount');
  createStubBin(ctx.directoryPath, 'findmnt', 'echo xfs');
  createStubBin(ctx.directoryPath, 'cp');
  createStubBin(ctx.nodesPath, 'mknod');

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: {
      PATH: `${join(ctx.nodesPath, 'bin')}:${ctx.bin}:${process.env['PATH'] ?? ''}`,
      IMP_STORAGE_ROOT: ctx.root,
      IMP_STORAGE_FILE: ctx.file,
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 0,
    stdout: `setup-storage: mounted ${ctx.file} on ${ctx.root}\n`,
    stderr: '',
  });

  expect(readFileSync(ctx.calls, 'utf8').split('\n')).toStrictEqual([
    `mountpoint -q ${ctx.root}`,
    `mountpoint -q ${ctx.directoryPath}/data`,
    `losetup -j ${ctx.file} -n -O NAME`,
    'losetup -f',
    `losetup /dev/loop7777 ${ctx.file}`,
    `mount -o nosuid /dev/loop7777 ${ctx.root}`,
    'losetup -d /dev/loop7777',
    `findmnt -n -o FSTYPE --mountpoint ${ctx.root}`,
    expect.toStartWith(`cp --reflink=always ${ctx.root}/.reflink-probe.`),
    '',
  ]);
});

test('it refuses a loop file that a loop device still holds, so two kernels never write one XFS', () => {
  const ctx = setupTest();

  writeFileSync(ctx.file, '');
  createStubBin(ctx.directoryPath, 'mountpoint', `[ "$2" != ${formatShellWord(ctx.root)} ]`);
  createStubBin(ctx.directoryPath, 'losetup', `[ "$1" != -j ] || echo /dev/loop3`);
  createStubBin(ctx.directoryPath, 'mount');
  createStubBin(ctx.nodesPath, 'mknod');

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: {
      PATH: `${join(ctx.nodesPath, 'bin')}:${ctx.bin}:${process.env['PATH'] ?? ''}`,
      IMP_STORAGE_ROOT: ctx.root,
      IMP_STORAGE_FILE: ctx.file,
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: `setup-storage: ${ctx.file} is still attached to /dev/loop3; wait for it to detach, or losetup -d it once nothing uses it\n`,
  });

  expect(readFileSync(ctx.calls, 'utf8').split('\n')).toStrictEqual([
    `mountpoint -q ${ctx.root}`,
    `mountpoint -q ${ctx.directoryPath}/data`,
    `losetup -j ${ctx.file} -n -O NAME`,
    '',
  ]);
});

test('it tries another loop device when another container takes the free one first', () => {
  const ctx = setupTest();
  const taken = formatShellWord(join(ctx.directoryPath, 'taken'));

  writeFileSync(ctx.file, '');
  createStubBin(ctx.directoryPath, 'mountpoint', `[ "$2" != ${formatShellWord(ctx.root)} ]`);

  createStubBin(
    ctx.directoryPath,
    'losetup',
    `case "$1" in
  -f) echo /dev/loop7777 ;;
  /dev/*) [ -e ${taken} ] || { touch ${taken}; exit 1; } ;;
esac`,
  );

  createStubBin(ctx.directoryPath, 'mount');
  createStubBin(ctx.directoryPath, 'findmnt', 'echo xfs');
  createStubBin(ctx.directoryPath, 'cp');
  createStubBin(ctx.nodesPath, 'mknod');

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: {
      PATH: `${join(ctx.nodesPath, 'bin')}:${ctx.bin}:${process.env['PATH'] ?? ''}`,
      IMP_STORAGE_ROOT: ctx.root,
      IMP_STORAGE_FILE: ctx.file,
    },
  });

  expect(result.exitCode).toBe(0);

  expect(readFileSync(ctx.calls, 'utf8').split('\n')).toStrictEqual([
    `mountpoint -q ${ctx.root}`,
    `mountpoint -q ${ctx.directoryPath}/data`,
    `losetup -j ${ctx.file} -n -O NAME`,
    'losetup -f',
    `losetup /dev/loop7777 ${ctx.file}`,
    'losetup -f',
    `losetup /dev/loop7777 ${ctx.file}`,
    `mount -o nosuid /dev/loop7777 ${ctx.root}`,
    'losetup -d /dev/loop7777',
    `findmnt -n -o FSTYPE --mountpoint ${ctx.root}`,
    expect.toStartWith(`cp --reflink=always ${ctx.root}/.reflink-probe.`),
    '',
  ]);
});

test('it gives up after five loop devices are taken before it can attach one', () => {
  const ctx = setupTest();

  writeFileSync(ctx.file, '');
  createStubBin(ctx.directoryPath, 'mountpoint', `[ "$2" != ${formatShellWord(ctx.root)} ]`);

  createStubBin(
    ctx.directoryPath,
    'losetup',
    `case "$1" in
  -f) echo /dev/loop7777 ;;
  /dev/*) exit 1 ;;
esac`,
  );

  createStubBin(ctx.directoryPath, 'mount');
  createStubBin(ctx.nodesPath, 'mknod');

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: {
      PATH: `${join(ctx.nodesPath, 'bin')}:${ctx.bin}:${process.env['PATH'] ?? ''}`,
      IMP_STORAGE_ROOT: ctx.root,
      IMP_STORAGE_FILE: ctx.file,
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: `setup-storage: no loop device for ${ctx.file} after 5 tries\n`,
  });

  expect(readFileSync(ctx.calls, 'utf8').split('\n')).toStrictEqual([
    `mountpoint -q ${ctx.root}`,
    `mountpoint -q ${ctx.directoryPath}/data`,
    `losetup -j ${ctx.file} -n -O NAME`,
    'losetup -f',
    `losetup /dev/loop7777 ${ctx.file}`,
    'losetup -f',
    `losetup /dev/loop7777 ${ctx.file}`,
    'losetup -f',
    `losetup /dev/loop7777 ${ctx.file}`,
    'losetup -f',
    `losetup /dev/loop7777 ${ctx.file}`,
    'losetup -f',
    `losetup /dev/loop7777 ${ctx.file}`,
    '',
  ]);
});

test('it fails when the kernel has no free loop device', () => {
  const ctx = setupTest();

  writeFileSync(ctx.file, '');
  createStubBin(ctx.directoryPath, 'mountpoint', `[ "$2" != ${formatShellWord(ctx.root)} ]`);
  createStubBin(ctx.directoryPath, 'losetup', `[ "$1" != -f ] || exit 1`);
  createStubBin(ctx.directoryPath, 'mount');
  createStubBin(ctx.nodesPath, 'mknod');

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: {
      PATH: `${join(ctx.nodesPath, 'bin')}:${ctx.bin}:${process.env['PATH'] ?? ''}`,
      IMP_STORAGE_ROOT: ctx.root,
      IMP_STORAGE_FILE: ctx.file,
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'setup-storage: no free loop device; is /dev/loop-control passed in?\n',
  });
});

test('it detaches the loop device and fails when the mount fails', () => {
  const ctx = setupTest();

  writeFileSync(ctx.file, '');
  createStubBin(ctx.directoryPath, 'mountpoint', `[ "$2" != ${formatShellWord(ctx.root)} ]`);
  createStubBin(ctx.directoryPath, 'losetup', `[ "$1" != -f ] || echo /dev/loop7777`);
  createStubBin(ctx.directoryPath, 'mount', "echo 'mount: wrong fs type' >&2; exit 32");
  createStubBin(ctx.nodesPath, 'mknod');

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: {
      PATH: `${join(ctx.nodesPath, 'bin')}:${ctx.bin}:${process.env['PATH'] ?? ''}`,
      IMP_STORAGE_ROOT: ctx.root,
      IMP_STORAGE_FILE: ctx.file,
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: `mount: wrong fs type\nsetup-storage: cannot mount /dev/loop7777 (${ctx.file}) on ${ctx.root}\n`,
  });

  expect(readFileSync(ctx.calls, 'utf8').split('\n')).toStrictEqual([
    `mountpoint -q ${ctx.root}`,
    `mountpoint -q ${ctx.directoryPath}/data`,
    `losetup -j ${ctx.file} -n -O NAME`,
    'losetup -f',
    `losetup /dev/loop7777 ${ctx.file}`,
    `mount -o nosuid /dev/loop7777 ${ctx.root}`,
    'losetup -d /dev/loop7777',
    '',
  ]);
});

test('it unmounts its own loop file and fails when the filesystem cannot reflink', () => {
  const ctx = setupTest();

  writeFileSync(ctx.file, '');
  createStubBin(ctx.directoryPath, 'mountpoint', `[ "$2" != ${formatShellWord(ctx.root)} ]`);
  createStubBin(ctx.directoryPath, 'losetup', `[ "$1" != -f ] || echo /dev/loop7777`);
  createStubBin(ctx.directoryPath, 'mount');
  createStubBin(ctx.directoryPath, 'umount');
  createStubBin(ctx.directoryPath, 'findmnt', 'echo xfs');
  createStubBin(ctx.directoryPath, 'cp', 'exit 1');
  createStubBin(ctx.nodesPath, 'mknod');

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: {
      PATH: `${join(ctx.nodesPath, 'bin')}:${ctx.bin}:${process.env['PATH'] ?? ''}`,
      IMP_STORAGE_ROOT: ctx.root,
      IMP_STORAGE_FILE: ctx.file,
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: `setup-storage: mounted ${ctx.file} on ${ctx.root}\n`,
    stderr: `setup-storage: ${ctx.root} is XFS without reflink (from ${ctx.file}); recreate it with mkfs.xfs -m reflink=1\n`,
  });

  expect(readFileSync(ctx.calls, 'utf8').split('\n')).toStrictEqual([
    `mountpoint -q ${ctx.root}`,
    `mountpoint -q ${ctx.directoryPath}/data`,
    `losetup -j ${ctx.file} -n -O NAME`,
    'losetup -f',
    `losetup /dev/loop7777 ${ctx.file}`,
    `mount -o nosuid /dev/loop7777 ${ctx.root}`,
    'losetup -d /dev/loop7777',
    `findmnt -n -o FSTYPE --mountpoint ${ctx.root}`,
    expect.toStartWith(`cp --reflink=always ${ctx.root}/.reflink-probe.`),
    `umount ${ctx.root}`,
    '',
  ]);

  expect(readdirSync(ctx.root)).toStrictEqual([]);
});

test('it unmounts its own loop file and fails when the loop file holds no XFS', () => {
  const ctx = setupTest();

  writeFileSync(ctx.file, '');
  createStubBin(ctx.directoryPath, 'mountpoint', `[ "$2" != ${formatShellWord(ctx.root)} ]`);
  createStubBin(ctx.directoryPath, 'losetup', `[ "$1" != -f ] || echo /dev/loop7777`);
  createStubBin(ctx.directoryPath, 'mount');
  createStubBin(ctx.directoryPath, 'umount');
  createStubBin(ctx.directoryPath, 'findmnt', 'echo ext4');
  createStubBin(ctx.nodesPath, 'mknod');

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: {
      PATH: `${join(ctx.nodesPath, 'bin')}:${ctx.bin}:${process.env['PATH'] ?? ''}`,
      IMP_STORAGE_ROOT: ctx.root,
      IMP_STORAGE_FILE: ctx.file,
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: `setup-storage: mounted ${ctx.file} on ${ctx.root}\n`,
    stderr: `setup-storage: ${ctx.root} is ext4 (from ${ctx.file}); imp needs XFS with reflink\n`,
  });

  expect(readFileSync(ctx.calls, 'utf8').split('\n')).toStrictEqual([
    `mountpoint -q ${ctx.root}`,
    `mountpoint -q ${ctx.directoryPath}/data`,
    `losetup -j ${ctx.file} -n -O NAME`,
    'losetup -f',
    `losetup /dev/loop7777 ${ctx.file}`,
    `mount -o nosuid /dev/loop7777 ${ctx.root}`,
    'losetup -d /dev/loop7777',
    `findmnt -n -o FSTYPE --mountpoint ${ctx.root}`,
    `umount ${ctx.root}`,
    '',
  ]);
});

test('it uses an XFS already mounted at the storage root as it is', () => {
  const ctx = setupTest();

  mkdirSync(ctx.root);
  createStubBin(ctx.directoryPath, 'mountpoint');
  createStubBin(ctx.directoryPath, 'findmnt', 'echo xfs');
  createStubBin(ctx.directoryPath, 'cp');

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: { PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`, IMP_STORAGE_ROOT: ctx.root },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 0,
    stdout: `setup-storage: ${ctx.root} already mounted\n`,
    stderr: '',
  });

  expect(readFileSync(ctx.calls, 'utf8').split('\n')).toStrictEqual([
    `mountpoint -q ${ctx.root}`,
    `findmnt -n -o FSTYPE --mountpoint ${ctx.root}`,
    expect.toStartWith(`cp --reflink=always ${ctx.root}/.reflink-probe.`),
    '',
  ]);
});

test('it never unmounts a filesystem it did not mount when that one cannot reflink', () => {
  const ctx = setupTest();

  mkdirSync(ctx.root);
  createStubBin(ctx.directoryPath, 'mountpoint');
  createStubBin(ctx.directoryPath, 'findmnt', 'echo xfs');
  createStubBin(ctx.directoryPath, 'cp', 'exit 1');
  createStubBin(ctx.directoryPath, 'umount');

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: { PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`, IMP_STORAGE_ROOT: ctx.root },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: `setup-storage: ${ctx.root} already mounted\n`,
    stderr: `setup-storage: ${ctx.root} is XFS without reflink; recreate it with mkfs.xfs -m reflink=1\n`,
  });

  expect(readFileSync(ctx.calls, 'utf8').split('\n')).toStrictEqual([
    `mountpoint -q ${ctx.root}`,
    `findmnt -n -o FSTYPE --mountpoint ${ctx.root}`,
    expect.toStartWith(`cp --reflink=always ${ctx.root}/.reflink-probe.`),
    '',
  ]);
});
