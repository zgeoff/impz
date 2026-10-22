import { expect, onTestFinished, test } from 'bun:test';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { formatShellWord } from '@impz/test-utils/format-shell-word';
import { createStubBin } from '../scripts/test-utils/create-stub-bin';
import { createStubRepoScript } from '../scripts/test-utils/create-stub-repo-script';

// build.sh keeps its sources and output beside itself, so each test runs a
// copy of it in a temp kernel folder, with curl and docker stubbed on PATH.
function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-kernel-build-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const kernel = join(directory, 'kernel');
  const stubs = join(directory, 'stubs');

  mkdirSync(kernel);
  copyFileSync(new URL('build.sh', import.meta.url).pathname, join(kernel, 'build.sh'));

  return {
    directoryPath: directory,
    kernel,
    build: join(kernel, '.build'),
    out: join(kernel, 'out'),
    stubs,
    calls: join(stubs, 'calls'),
    path: `${join(stubs, 'bin')}:${process.env['PATH'] ?? ''}`,
    script: join(kernel, 'build.sh'),
  };
}

test('it refuses an argument it does not know, before it touches anything', () => {
  const ctx = setupTest();

  createStubBin(ctx.stubs, 'curl');
  createStubBin(ctx.stubs, 'docker');

  const result = Bun.spawnSync([ctx.script, '--release'], { env: { PATH: ctx.path } });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 2,
    stdout: '',
    stderr: 'usage: kernel/build.sh [--fetch | --in-builder]\n',
  });

  expect(readFileSync(ctx.calls, 'utf8')).toBe('');
  expect(existsSync(ctx.build)).toBeFalse();
});

test('it downloads, checks and unpacks the source, then builds it in the kernel-builder container', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.kernel, 'version'), 'KVER=6.1.999\nKSHA256=0\n');

  const source = join(ctx.directoryPath, 'source');
  const tarball = join(ctx.directoryPath, 'linux.tar');

  mkdirSync(join(source, 'linux-6.1.999'), { recursive: true });
  writeFileSync(join(source, 'linux-6.1.999', 'Makefile'), 'VERSION = 6\n');

  Bun.spawnSync(['tar', '-C', source, '-cf', tarball, 'linux-6.1.999']);

  const sha256 = new Bun.CryptoHasher('sha256').update(readFileSync(tarball)).digest('hex');

  createStubBin(ctx.stubs, 'curl', `cp ${formatShellWord(tarball)} "$5"`);
  createStubBin(ctx.stubs, 'docker');

  // docker run writes it in the container
  mkdirSync(ctx.out);
  writeFileSync(join(ctx.out, 'vmlinux'), 'ELF');

  const result = Bun.spawnSync([ctx.script], {
    env: { PATH: ctx.path, JOBS: '7', KSHA256: sha256 },
  });

  expect(result.stderr.toString()).toBe('');
  expect(result.exitCode).toBe(0);

  expect(result.stdout.toString().split('\n')).toStrictEqual([
    `${ctx.build}/linux-6.1.999.tar.xz: OK`,
    expect.toEndWith(` ${ctx.out}/vmlinux`),
    '',
  ]);

  expect(readFileSync(ctx.calls, 'utf8').split('\n')).toStrictEqual([
    `curl -fL --retry 3 -o ${ctx.build}/linux-6.1.999.tar.xz.part https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.1.999.tar.xz`,
    `docker build -q -t imp-kernel-builder:dev --target kernel-builder -f ${ctx.kernel}/../host/Dockerfile ${ctx.kernel}/..`,
    `docker run --rm --user ${userInfo().uid}:${userInfo().gid} -v ${ctx.kernel}:/k -e JOBS=7 imp-kernel-builder:dev /k/make-vmlinux.sh /k/.build/linux-6.1.999 /k/.build/obj /k/out`,
    '',
  ]);

  expect(readdirSync(ctx.build).toSorted()).toStrictEqual([
    'linux-6.1.999',
    'linux-6.1.999.tar.xz',
  ]);

  expect(readFileSync(join(ctx.build, 'linux-6.1.999', 'Makefile'), 'utf8')).toBe('VERSION = 6\n');
});

test('it stops after unpacking the source with --fetch', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.kernel, 'version'), 'KVER=6.1.999\nKSHA256=0\n');

  const source = join(ctx.directoryPath, 'source');
  const tarball = join(ctx.directoryPath, 'linux.tar');

  mkdirSync(join(source, 'linux-6.1.999'), { recursive: true });
  writeFileSync(join(source, 'linux-6.1.999', 'Makefile'), 'VERSION = 6\n');

  Bun.spawnSync(['tar', '-C', source, '-cf', tarball, 'linux-6.1.999']);

  const sha256 = new Bun.CryptoHasher('sha256').update(readFileSync(tarball)).digest('hex');

  createStubBin(ctx.stubs, 'curl', `cp ${formatShellWord(tarball)} "$5"`);
  createStubBin(ctx.stubs, 'docker');

  const result = Bun.spawnSync([ctx.script, '--fetch'], {
    env: { PATH: ctx.path, JOBS: '7', KSHA256: sha256 },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 0,
    stdout: `${ctx.build}/linux-6.1.999.tar.xz: OK\n`,
    stderr: '',
  });

  expect(readFileSync(ctx.calls, 'utf8').split('\n')).toStrictEqual([
    `curl -fL --retry 3 -o ${ctx.build}/linux-6.1.999.tar.xz.part https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.1.999.tar.xz`,
    '',
  ]);

  expect(readFileSync(join(ctx.build, 'linux-6.1.999', 'Makefile'), 'utf8')).toBe('VERSION = 6\n');
});

test('it checks and unpacks a tarball it downloaded before without downloading it again', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.kernel, 'version'), 'KVER=6.1.999\nKSHA256=0\n');

  const source = join(ctx.directoryPath, 'source');

  mkdirSync(join(source, 'linux-6.1.999'), { recursive: true });
  mkdirSync(ctx.build);
  writeFileSync(join(source, 'linux-6.1.999', 'Makefile'), 'VERSION = 6\n');

  Bun.spawnSync([
    'tar',
    '-C',
    source,
    '-cf',
    join(ctx.build, 'linux-6.1.999.tar.xz'),
    'linux-6.1.999',
  ]);

  const sha256 = new Bun.CryptoHasher('sha256')
    .update(readFileSync(join(ctx.build, 'linux-6.1.999.tar.xz')))
    .digest('hex');

  createStubBin(ctx.stubs, 'curl');
  createStubBin(ctx.stubs, 'docker');

  const result = Bun.spawnSync([ctx.script, '--fetch'], {
    env: { PATH: ctx.path, JOBS: '7', KSHA256: sha256 },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 0,
    stdout: `${ctx.build}/linux-6.1.999.tar.xz: OK\n`,
    stderr: '',
  });

  expect(readFileSync(ctx.calls, 'utf8')).toBe('');
  expect(readFileSync(join(ctx.build, 'linux-6.1.999', 'Makefile'), 'utf8')).toBe('VERSION = 6\n');
});

test('it neither downloads nor checks a tarball when the source is already unpacked', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.kernel, 'version'), 'KVER=6.1.999\nKSHA256=0\n');
  mkdirSync(join(ctx.build, 'linux-6.1.999'), { recursive: true });
  createStubBin(ctx.stubs, 'curl');
  createStubBin(ctx.stubs, 'docker');

  const result = Bun.spawnSync([ctx.script, '--fetch'], { env: { PATH: ctx.path, JOBS: '7' } });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });

  expect(readFileSync(ctx.calls, 'utf8')).toBe('');
});

test('it refuses a tarball whose sha256 does not match, and unpacks nothing', () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.kernel, 'version'),
    'KVER=6.1.999\nKSHA256=1111111111111111111111111111111111111111111111111111111111111111\n',
  );

  mkdirSync(ctx.build);
  writeFileSync(join(ctx.build, 'linux-6.1.999.tar.xz'), 'not the release\n');
  createStubBin(ctx.stubs, 'curl');
  createStubBin(ctx.stubs, 'docker');

  const result = Bun.spawnSync([ctx.script], { env: { PATH: ctx.path, JOBS: '7' } });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: `${ctx.build}/linux-6.1.999.tar.xz: FAILED\n`,
    stderr: 'sha256sum: WARNING: 1 computed checksum did NOT match\n',
  });

  expect(readFileSync(ctx.calls, 'utf8')).toBe('');
  expect(readdirSync(ctx.build)).toStrictEqual(['linux-6.1.999.tar.xz']);
});

test('it takes KVER and KSHA256 from the environment over kernel/version', () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.kernel, 'version'),
    'KVER=6.1.111\nKSHA256=1111111111111111111111111111111111111111111111111111111111111111\n',
  );

  const source = join(ctx.directoryPath, 'source');
  const tarball = join(ctx.directoryPath, 'linux.tar');

  mkdirSync(join(source, 'linux-6.1.222'), { recursive: true });
  writeFileSync(join(source, 'linux-6.1.222', 'Makefile'), 'VERSION = 6\n');

  Bun.spawnSync(['tar', '-C', source, '-cf', tarball, 'linux-6.1.222']);

  const sha256 = new Bun.CryptoHasher('sha256').update(readFileSync(tarball)).digest('hex');

  createStubBin(ctx.stubs, 'curl', `cp ${formatShellWord(tarball)} "$5"`);
  createStubBin(ctx.stubs, 'docker');

  const result = Bun.spawnSync([ctx.script, '--fetch'], {
    env: { PATH: ctx.path, JOBS: '7', KVER: '6.1.222', KSHA256: sha256 },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 0,
    stdout: `${ctx.build}/linux-6.1.222.tar.xz: OK\n`,
    stderr: '',
  });

  expect(readFileSync(ctx.calls, 'utf8').split('\n')).toStrictEqual([
    `curl -fL --retry 3 -o ${ctx.build}/linux-6.1.222.tar.xz.part https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.1.222.tar.xz`,
    '',
  ]);

  expect(readdirSync(ctx.build).toSorted()).toStrictEqual([
    'linux-6.1.222',
    'linux-6.1.222.tar.xz',
  ]);
});

test('it keeps no tarball from a download that fails, so the next run downloads again', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.kernel, 'version'), 'KVER=6.1.999\nKSHA256=0\n');
  createStubBin(ctx.stubs, 'curl', 'printf partial >"$5"\nexit 22');
  createStubBin(ctx.stubs, 'docker');

  const result = Bun.spawnSync([ctx.script], { env: { PATH: ctx.path, JOBS: '7' } });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({ exitCode: 22, stdout: '', stderr: '' });

  expect(readFileSync(ctx.calls, 'utf8').split('\n')).toStrictEqual([
    `curl -fL --retry 3 -o ${ctx.build}/linux-6.1.999.tar.xz.part https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.1.999.tar.xz`,
    '',
  ]);

  expect(readdirSync(ctx.build)).toStrictEqual(['linux-6.1.999.tar.xz.part']);
});

test('it runs make-vmlinux.sh on the unpacked source itself with --in-builder', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.kernel, 'version'), 'KVER=6.1.999\nKSHA256=0\n');
  mkdirSync(join(ctx.build, 'linux-6.1.999'), { recursive: true });
  createStubBin(ctx.stubs, 'curl');
  createStubBin(ctx.stubs, 'docker');

  createStubRepoScript(
    ctx.kernel,
    'make-vmlinux.sh',
    ctx.calls,
    `printf '%s\\n' "JOBS=$JOBS" >>${formatShellWord(ctx.calls)}`,
  );

  const result = Bun.spawnSync([ctx.script, '--in-builder'], {
    env: { PATH: ctx.path, JOBS: '7' },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });

  expect(readFileSync(ctx.calls, 'utf8').split('\n')).toStrictEqual([
    `make-vmlinux.sh ${ctx.build}/linux-6.1.999 ${ctx.build}/obj ${ctx.out}`,
    'JOBS=7',
    '',
  ]);
});

test('it builds with one job per processor when JOBS is unset', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.kernel, 'version'), 'KVER=6.1.999\nKSHA256=0\n');
  mkdirSync(join(ctx.build, 'linux-6.1.999'), { recursive: true });
  createStubBin(ctx.stubs, 'nproc', 'echo 3');

  createStubRepoScript(
    ctx.kernel,
    'make-vmlinux.sh',
    ctx.calls,
    `printf '%s\\n' "JOBS=$JOBS" >>${formatShellWord(ctx.calls)}`,
  );

  const result = Bun.spawnSync([ctx.script, '--in-builder'], { env: { PATH: ctx.path } });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });

  expect(readFileSync(ctx.calls, 'utf8').split('\n')).toStrictEqual([
    'nproc ',
    `make-vmlinux.sh ${ctx.build}/linux-6.1.999 ${ctx.build}/obj ${ctx.out}`,
    'JOBS=3',
    '',
  ]);
});
