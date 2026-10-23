import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubEnvRecord } from './build-stub-env-record';
import { createStubBin } from './create-stub-bin';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-stub-env-record-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
}

test('it logs each variable with its value on one indented line after the call', () => {
  const ctx = setupTest();

  const stub = createStubBin(
    ctx.directoryPath,
    'make',
    buildStubEnvRecord(['KBUILD_BUILD_USER', 'JOBS']),
  );

  Bun.spawnSync([join(stub.bin, 'make'), 'vmlinux'], {
    env: { KBUILD_BUILD_USER: 'imp', JOBS: '5' },
  });

  expect(readFileSync(stub.calls, 'utf8')).toBe('make vmlinux\n  KBUILD_BUILD_USER=imp JOBS=5\n');
});

test('it logs an unset variable as empty', () => {
  const ctx = setupTest();
  const stub = createStubBin(ctx.directoryPath, 'impd', buildStubEnvRecord(['IMP_TAILSCALE_NODE']));

  Bun.spawnSync([join(stub.bin, 'impd')], { env: {} });

  expect(readFileSync(stub.calls, 'utf8')).toBe('impd \n  IMP_TAILSCALE_NODE=\n');
});

test('it logs a value with spaces and quotes as it is', () => {
  const ctx = setupTest();

  const stub = createStubBin(
    ctx.directoryPath,
    'make',
    buildStubEnvRecord(['KBUILD_BUILD_TIMESTAMP']),
  );

  Bun.spawnSync([join(stub.bin, 'make')], {
    env: { KBUILD_BUILD_TIMESTAMP: `1970-01-01 "00:00" 'UTC'` },
  });

  expect(readFileSync(stub.calls, 'utf8')).toBe(
    `make \n  KBUILD_BUILD_TIMESTAMP=1970-01-01 "00:00" 'UTC'\n`,
  );
});

test('it logs the directory a stub runs in through PWD', () => {
  const ctx = setupTest();
  const stub = createStubBin(ctx.directoryPath, 'merge_config.sh', buildStubEnvRecord(['PWD']));

  Bun.spawnSync([join(stub.bin, 'merge_config.sh')], { cwd: ctx.directoryPath, env: {} });

  expect(readFileSync(stub.calls, 'utf8')).toBe(`merge_config.sh \n  PWD=${ctx.directoryPath}\n`);
});
