import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubBin } from '../../scripts/test-utils/create-stub-bin';
import { createStubCat } from '../../scripts/test-utils/create-stub-cat';

// Each test points setup-cgroups.sh at a plain directory for /sys/fs/cgroup,
// and a cat stub answers for /proc/self/cgroup, whose real value differs by host.
function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-setup-cgroups-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const root = join(directory, 'cgroup');

  mkdirSync(root);

  return {
    directoryPath: directory,
    root,
    bin: join(directory, 'bin'),
    calls: join(directory, 'calls'),
    script: new URL('setup-cgroups.sh', import.meta.url).pathname,
  };
}

test('it turns limits off when the container is not in a private cgroup v2 namespace', () => {
  const ctx = setupTest();

  createStubCat(ctx.directoryPath, { '/proc/self/cgroup': '0::/system.slice/docker.scope' });
  createStubBin(ctx.directoryPath, 'findmnt', 'echo rw,relatime');

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: { PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`, IMP_CGROUP_ROOT: ctx.root },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 0,
    stdout: '',
    stderr: 'setup-cgroups: not in a private cgroup v2 namespace; CPU and memory limits are off\n',
  });

  expect(readFileSync(ctx.calls, 'utf8')).toBe('cat /proc/self/cgroup\n');
});

test('it turns CPU and memory limits on when both controllers reach the imps cgroup', () => {
  const ctx = setupTest();

  createStubCat(ctx.directoryPath, { '/proc/self/cgroup': '0::/' });
  createStubBin(ctx.directoryPath, 'findmnt', 'echo rw,nosuid,nodev,noexec,relatime');
  writeFileSync(join(ctx.root, 'cgroup.procs'), '');
  writeFileSync(join(ctx.root, 'cgroup.controllers'), 'cpuset cpu io memory pids\n');
  mkdirSync(join(ctx.root, 'imps'));
  writeFileSync(join(ctx.root, 'imps', 'cgroup.controllers'), 'cpu memory\n');

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: { PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`, IMP_CGROUP_ROOT: ctx.root },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 0,
    stdout: 'setup-cgroups: CPU limits on\nsetup-cgroups: memory limits on\n',
    stderr: '',
  });

  expect(readFileSync(ctx.calls, 'utf8').split('\n')).toStrictEqual([
    'cat /proc/self/cgroup',
    `findmnt -n -o OPTIONS --mountpoint ${ctx.root}`,
    `cat ${ctx.root}/cgroup.procs`,
    '',
  ]);

  expect(readFileSync(join(ctx.root, 'cgroup.subtree_control'), 'utf8')).toBe('+memory\n');
  expect(readFileSync(join(ctx.root, 'imps', 'cgroup.subtree_control'), 'utf8')).toBe('+memory\n');
});

test('it moves every process to the init cgroup, reading the list again up to five times', () => {
  const ctx = setupTest();

  createStubCat(ctx.directoryPath, { '/proc/self/cgroup': '0::/' });
  createStubBin(ctx.directoryPath, 'findmnt', 'echo rw,relatime');
  writeFileSync(join(ctx.root, 'cgroup.procs'), '1\n42\n');
  writeFileSync(join(ctx.root, 'cgroup.controllers'), 'cpu memory\n');
  mkdirSync(join(ctx.root, 'imps'));
  writeFileSync(join(ctx.root, 'imps', 'cgroup.controllers'), 'cpu memory\n');

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: { PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`, IMP_CGROUP_ROOT: ctx.root },
  });

  expect(result.exitCode).toBe(0);

  // a plain file keeps its pids, where the kernel's cgroup.procs drops each one that moves
  expect(readFileSync(ctx.calls, 'utf8').split('\n')).toStrictEqual([
    'cat /proc/self/cgroup',
    `findmnt -n -o OPTIONS --mountpoint ${ctx.root}`,
    `cat ${ctx.root}/cgroup.procs`,
    `cat ${ctx.root}/cgroup.procs`,
    `cat ${ctx.root}/cgroup.procs`,
    `cat ${ctx.root}/cgroup.procs`,
    `cat ${ctx.root}/cgroup.procs`,
    '',
  ]);

  expect(readFileSync(join(ctx.root, 'init', 'cgroup.procs'), 'utf8')).toBe('42\n');
});

test('it remounts a read-only cgroup mount read-write and goes on', () => {
  const ctx = setupTest();

  createStubCat(ctx.directoryPath, { '/proc/self/cgroup': '0::/' });
  createStubBin(ctx.directoryPath, 'findmnt', 'echo ro,nosuid,nodev,noexec,relatime');
  createStubBin(ctx.directoryPath, 'mount');
  writeFileSync(join(ctx.root, 'cgroup.procs'), '');
  writeFileSync(join(ctx.root, 'cgroup.controllers'), 'cpu memory\n');
  mkdirSync(join(ctx.root, 'imps'));
  writeFileSync(join(ctx.root, 'imps', 'cgroup.controllers'), 'cpu memory\n');

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: { PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`, IMP_CGROUP_ROOT: ctx.root },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 0,
    stdout: 'setup-cgroups: CPU limits on\nsetup-cgroups: memory limits on\n',
    stderr: '',
  });

  expect(readFileSync(ctx.calls, 'utf8').split('\n')).toStrictEqual([
    'cat /proc/self/cgroup',
    `findmnt -n -o OPTIONS --mountpoint ${ctx.root}`,
    `mount -o remount,rw ${ctx.root}`,
    `cat ${ctx.root}/cgroup.procs`,
    '',
  ]);
});

test('it turns limits off when the read-only cgroup mount cannot be remounted', () => {
  const ctx = setupTest();

  createStubCat(ctx.directoryPath, { '/proc/self/cgroup': '0::/' });
  createStubBin(ctx.directoryPath, 'findmnt', 'echo ro,relatime');
  createStubBin(ctx.directoryPath, 'mount', "echo 'mount: permission denied' >&2; exit 32");

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: { PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`, IMP_CGROUP_ROOT: ctx.root },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 0,
    stdout: '',
    stderr: `setup-cgroups: cannot remount ${ctx.root} read-write; CPU and memory limits are off\n`,
  });

  expect(readFileSync(ctx.calls, 'utf8').split('\n')).toStrictEqual([
    'cat /proc/self/cgroup',
    `findmnt -n -o OPTIONS --mountpoint ${ctx.root}`,
    `mount -o remount,rw ${ctx.root}`,
    '',
  ]);
});

test('it never remounts a read-write mount whose options only contain ro inside a word', () => {
  const ctx = setupTest();

  createStubCat(ctx.directoryPath, { '/proc/self/cgroup': '0::/' });
  createStubBin(ctx.directoryPath, 'findmnt', 'echo rw,relatime,errors=remount-ro');
  createStubBin(ctx.directoryPath, 'mount');
  writeFileSync(join(ctx.root, 'cgroup.procs'), '');
  writeFileSync(join(ctx.root, 'cgroup.controllers'), 'cpu memory\n');
  mkdirSync(join(ctx.root, 'imps'));
  writeFileSync(join(ctx.root, 'imps', 'cgroup.controllers'), 'cpu memory\n');

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: { PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`, IMP_CGROUP_ROOT: ctx.root },
  });

  expect(result.exitCode).toBe(0);

  expect(readFileSync(ctx.calls, 'utf8').split('\n')).toStrictEqual([
    'cat /proc/self/cgroup',
    `findmnt -n -o OPTIONS --mountpoint ${ctx.root}`,
    `cat ${ctx.root}/cgroup.procs`,
    '',
  ]);
});

test('it turns limits off and makes no imps cgroup when the root has no cpu controller', () => {
  const ctx = setupTest();

  createStubCat(ctx.directoryPath, { '/proc/self/cgroup': '0::/' });
  createStubBin(ctx.directoryPath, 'findmnt', 'echo rw,relatime');
  writeFileSync(join(ctx.root, 'cgroup.procs'), '');
  writeFileSync(join(ctx.root, 'cgroup.controllers'), 'cpuset io memory pids\n');

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: { PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`, IMP_CGROUP_ROOT: ctx.root },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 0,
    stdout: '',
    stderr: `setup-cgroups: no cpu controller in ${ctx.root}; cpu limits are off\n`,
  });

  expect(existsSync(join(ctx.root, 'imps'))).toBeFalse();
});

test('it turns limits off when the root cannot enable the cpu controller', () => {
  const ctx = setupTest();

  createStubCat(ctx.directoryPath, { '/proc/self/cgroup': '0::/' });
  createStubBin(ctx.directoryPath, 'findmnt', 'echo rw,relatime');
  writeFileSync(join(ctx.root, 'cgroup.procs'), '');
  writeFileSync(join(ctx.root, 'cgroup.controllers'), 'cpu memory\n');

  // a write to a directory fails for every user, root included
  mkdirSync(join(ctx.root, 'cgroup.subtree_control'));

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: { PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`, IMP_CGROUP_ROOT: ctx.root },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 0,
    stdout: '',
    stderr: `setup-cgroups: cannot enable cpu in ${ctx.root}; cpu limits are off\n`,
  });
});

test('it turns limits off when the imps cgroup has no cpu controller', () => {
  const ctx = setupTest();

  createStubCat(ctx.directoryPath, { '/proc/self/cgroup': '0::/' });
  createStubBin(ctx.directoryPath, 'findmnt', 'echo rw,relatime');
  writeFileSync(join(ctx.root, 'cgroup.procs'), '');
  writeFileSync(join(ctx.root, 'cgroup.controllers'), 'cpu memory\n');
  mkdirSync(join(ctx.root, 'imps'));
  writeFileSync(join(ctx.root, 'imps', 'cgroup.controllers'), 'memory\n');

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: { PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`, IMP_CGROUP_ROOT: ctx.root },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 0,
    stdout: '',
    stderr: `setup-cgroups: no cpu controller in ${ctx.root}/imps; cpu limits are off\n`,
  });
});

test('it keeps CPU limits on without memory limits when the imps cgroup has no memory controller', () => {
  const ctx = setupTest();

  createStubCat(ctx.directoryPath, { '/proc/self/cgroup': '0::/' });
  createStubBin(ctx.directoryPath, 'findmnt', 'echo rw,relatime');
  writeFileSync(join(ctx.root, 'cgroup.procs'), '');
  writeFileSync(join(ctx.root, 'cgroup.controllers'), 'cpu memory\n');
  mkdirSync(join(ctx.root, 'imps'));
  writeFileSync(join(ctx.root, 'imps', 'cgroup.controllers'), 'cpu\n');

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: { PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`, IMP_CGROUP_ROOT: ctx.root },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 0,
    stdout: 'setup-cgroups: CPU limits on\n',
    stderr: `setup-cgroups: no memory controller in ${ctx.root}/imps; memory limits are off\n`,
  });

  expect(readFileSync(join(ctx.root, 'imps', 'cgroup.subtree_control'), 'utf8')).toBe('+cpu\n');
});

test('it goes on quietly when a process cannot move to the init cgroup', () => {
  const ctx = setupTest();

  createStubCat(ctx.directoryPath, { '/proc/self/cgroup': '0::/' });
  createStubBin(ctx.directoryPath, 'findmnt', 'echo rw,relatime');
  writeFileSync(join(ctx.root, 'cgroup.procs'), '1\n');
  writeFileSync(join(ctx.root, 'cgroup.controllers'), 'cpu memory\n');
  mkdirSync(join(ctx.root, 'imps'));
  writeFileSync(join(ctx.root, 'imps', 'cgroup.controllers'), 'cpu memory\n');

  // a write to a directory fails for every user, root included
  mkdirSync(join(ctx.root, 'init', 'cgroup.procs'), { recursive: true });

  const result = Bun.spawnSync(['bash', ctx.script], {
    env: { PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`, IMP_CGROUP_ROOT: ctx.root },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 0,
    stdout: 'setup-cgroups: CPU limits on\nsetup-cgroups: memory limits on\n',
    stderr: '',
  });
});
