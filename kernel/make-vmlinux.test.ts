import { expect, onTestFinished, test } from 'bun:test';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubShellScript } from '@impz/scripts/test-utils/create-stub-shell-script';
import { formatStubCalls } from '@impz/shared/test-utils/format-stub-calls';
import { createStubBin, readStubCalls } from '@zgeoff/testing/bin';

// make-vmlinux.sh reads its config inputs beside itself, so each test runs a
// copy of it in a temp kernel folder, with make and the source tree's
// merge_config.sh stubbed to record their argv and the build metadata.
function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-make-vmlinux-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const kernel = join(directory, 'kernel');
  const source = join(directory, 'linux-6.1.999');
  const stubs = join(directory, 'stubs');

  mkdirSync(kernel);
  mkdirSync(join(source, 'scripts', 'kconfig'), { recursive: true });

  copyFileSync(
    new URL('make-vmlinux.sh', import.meta.url).pathname,
    join(kernel, 'make-vmlinux.sh'),
  );

  createStubBin(stubs, 'make', {
    recordEnv: [
      'KBUILD_BUILD_TIMESTAMP',
      'KBUILD_BUILD_USER',
      'KBUILD_BUILD_HOST',
      'KBUILD_BUILD_VERSION',
    ],
  });

  createStubShellScript(
    stubs,
    'merge_config',
    { recordEnv: ['KCONFIG_CONFIG', 'PWD'] },
    join(source, 'scripts', 'kconfig'),
  );

  return {
    kernel,
    source,
    obj: join(directory, 'obj'),
    out: join(directory, 'out'),
    stubs,
    path: `${stubs}:${process.env['PATH'] ?? ''}`,
    script: join(kernel, 'make-vmlinux.sh'),
  };
}

test('it merges the config, builds vmlinux with fixed build metadata, and copies vmlinux and the config out', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.kernel, 'config-base'), 'CONFIG_PRINTK=y\n');

  writeFileSync(
    join(ctx.kernel, 'docker.fragment'),
    '# netfilter\nCONFIG_NF_TABLES=y\nCONFIG_VETH=y\n# CONFIG_MODULES is not set\n',
  );

  // the object tree a previous run left, which the stubbed make leaves alone
  mkdirSync(ctx.obj);
  writeFileSync(join(ctx.obj, '.config'), 'CONFIG_PRINTK=y\nCONFIG_NF_TABLES=y\nCONFIG_VETH=y\n');
  writeFileSync(join(ctx.obj, 'vmlinux'), 'ELF');

  const result = Bun.spawnSync([ctx.script, ctx.source, ctx.obj, ctx.out], {
    env: { PATH: ctx.path, JOBS: '5' },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });

  expect(formatStubCalls(readStubCalls(ctx.stubs)).split('\n')).toStrictEqual([
    `merge_config -m -O ${ctx.obj} ${ctx.kernel}/config-base ${ctx.kernel}/docker.fragment`,
    `  KCONFIG_CONFIG=${ctx.obj}/.config PWD=${ctx.source}`,
    `make O=${ctx.obj} olddefconfig`,
    '  KBUILD_BUILD_TIMESTAMP=1970-01-01 00:00:00 UTC KBUILD_BUILD_USER=imp KBUILD_BUILD_HOST=imp KBUILD_BUILD_VERSION=1',
    `make O=${ctx.obj} -j5 vmlinux`,
    '  KBUILD_BUILD_TIMESTAMP=1970-01-01 00:00:00 UTC KBUILD_BUILD_USER=imp KBUILD_BUILD_HOST=imp KBUILD_BUILD_VERSION=1',
    '',
  ]);

  expect(readFileSync(join(ctx.out, 'vmlinux'), 'utf8')).toBe('ELF');

  expect(readFileSync(join(ctx.out, 'config'), 'utf8')).toBe(
    'CONFIG_PRINTK=y\nCONFIG_NF_TABLES=y\nCONFIG_VETH=y\n',
  );
});

test('it fails naming each fragment symbol that the final config lacks or sets otherwise', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.kernel, 'config-base'), 'CONFIG_PRINTK=y\n');

  writeFileSync(
    join(ctx.kernel, 'docker.fragment'),
    'CONFIG_NF_TABLES=y\nCONFIG_VETH=m\nCONFIG_CMDLINE="console=ttyS0"\n',
  );

  mkdirSync(ctx.obj);
  writeFileSync(join(ctx.obj, '.config'), 'CONFIG_PRINTK=y\nCONFIG_NF_TABLES=y\nCONFIG_VETH=y\n');
  writeFileSync(join(ctx.obj, 'vmlinux'), 'ELF');

  const result = Bun.spawnSync([ctx.script, ctx.source, ctx.obj, ctx.out], {
    env: { PATH: ctx.path, JOBS: '5' },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: [
      'make-vmlinux: CONFIG_VETH=m not in final config',
      'make-vmlinux: CONFIG_CMDLINE="console=ttyS0" not in final config',
      '',
    ].join('\n'),
  });

  expect(readFileSync(join(ctx.out, 'config'), 'utf8')).toBe(
    'CONFIG_PRINTK=y\nCONFIG_NF_TABLES=y\nCONFIG_VETH=y\n',
  );
});

test('it stops at the first make that fails and copies nothing out', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.kernel, 'config-base'), 'CONFIG_PRINTK=y\n');
  writeFileSync(join(ctx.kernel, 'docker.fragment'), 'CONFIG_NF_TABLES=y\n');
  createStubBin(ctx.stubs, 'make', { script: '#!/bin/bash\nexit 2' });

  const result = Bun.spawnSync([ctx.script, ctx.source, ctx.obj, ctx.out], {
    env: { PATH: ctx.path, JOBS: '5' },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({ exitCode: 2, stdout: '', stderr: '' });

  expect(formatStubCalls(readStubCalls(ctx.stubs)).split('\n')).toStrictEqual([
    `merge_config -m -O ${ctx.obj} ${ctx.kernel}/config-base ${ctx.kernel}/docker.fragment`,
    `  KCONFIG_CONFIG=${ctx.obj}/.config PWD=${ctx.source}`,
    `make O=${ctx.obj} olddefconfig`,
    '',
  ]);

  expect(existsSync(join(ctx.out, 'vmlinux'))).toBeFalse();
});

test('it builds with one job per processor when JOBS is unset', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.kernel, 'config-base'), 'CONFIG_PRINTK=y\n');
  writeFileSync(join(ctx.kernel, 'docker.fragment'), 'CONFIG_NF_TABLES=y\n');
  mkdirSync(ctx.obj);
  writeFileSync(join(ctx.obj, '.config'), 'CONFIG_PRINTK=y\nCONFIG_NF_TABLES=y\n');
  writeFileSync(join(ctx.obj, 'vmlinux'), 'ELF');
  createStubBin(ctx.stubs, 'make');
  createStubBin(ctx.stubs, 'nproc', { script: '#!/bin/bash\necho 3' });

  const result = Bun.spawnSync([ctx.script, ctx.source, ctx.obj, ctx.out], {
    env: { PATH: ctx.path },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });

  expect(formatStubCalls(readStubCalls(ctx.stubs)).split('\n')).toStrictEqual([
    'nproc ',
    `merge_config -m -O ${ctx.obj} ${ctx.kernel}/config-base ${ctx.kernel}/docker.fragment`,
    `  KCONFIG_CONFIG=${ctx.obj}/.config PWD=${ctx.source}`,
    `make O=${ctx.obj} olddefconfig`,
    `make O=${ctx.obj} -j3 vmlinux`,
    '',
  ]);
});

test('it refuses to run without the source, object and output folders', () => {
  const ctx = setupTest();
  const result = Bun.spawnSync([ctx.script], { env: { PATH: ctx.path, JOBS: '5' } });

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toEndWith(': $1: unbound variable\n');
  expect(formatStubCalls(readStubCalls(ctx.stubs))).toBe('');
});
