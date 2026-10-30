import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubBin } from '@impz/test-utils/create-stub-bin';
import { $ } from 'bun';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-small-fs-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  mkdirSync(join(directory, 'temp'));

  return {
    directoryPath: directory,
    runnerTemp: join(directory, 'temp'),
    owner: `${String(process.getuid?.())}:${String(process.getgid?.())}`,
    scriptPath: join(import.meta.dir, 'run-small-fs-tests.ts'),
  };
}

test('it runs the lane on a loop-mounted XFS of its own, and removes it after', async () => {
  const ctx = setupTest();
  const sudo = createStubBin(ctx.directoryPath, 'sudo');

  createStubBin(ctx.directoryPath, 'truncate');
  createStubBin(ctx.directoryPath, 'mkfs.xfs');

  createStubBin(
    ctx.directoryPath,
    'bun',
    'echo "IMP_TEST_SMALL_FS=$IMP_TEST_SMALL_FS" >>"$STUB_CALLS"',
  );

  const result = await $`${process.execPath} ${ctx.scriptPath}`
    .env({ PATH: sudo.bin, RUNNER_TEMP: ctx.runnerTemp })
    .nothrow()
    .quiet();

  const fs = join(ctx.runnerTemp, 'small-fs');

  expect(result.exitCode).toBe(0);

  expect(readFileSync(sudo.calls, 'utf8')).toBe(
    [
      `truncate -s 4G ${fs}.img`,
      `mkfs.xfs -q ${fs}.img`,
      `sudo mount -o loop ${fs}.img ${fs}`,
      `sudo chown ${ctx.owner} ${fs}`,
      'bun run test:small-fs',
      `IMP_TEST_SMALL_FS=${fs}`,
      `sudo umount ${fs}`,
      '',
    ].join('\n'),
  );

  expect(existsSync(fs)).toBeFalse();
});

test('it installs xfsprogs on a runner without mkfs.xfs', async () => {
  const ctx = setupTest();
  const sudo = createStubBin(ctx.directoryPath, 'sudo');

  createStubBin(ctx.directoryPath, 'truncate');
  createStubBin(ctx.directoryPath, 'bun');

  await $`${process.execPath} ${ctx.scriptPath}`
    .env({ PATH: sudo.bin, RUNNER_TEMP: ctx.runnerTemp })
    .nothrow()
    .quiet();

  expect(readFileSync(sudo.calls, 'utf8')).toStartWith(
    'sudo apt-get update\nsudo apt-get install -y --no-install-recommends xfsprogs\n',
  );
});

test('it fails with the lane, and unmounts all the same', async () => {
  const ctx = setupTest();
  const sudo = createStubBin(ctx.directoryPath, 'sudo');

  createStubBin(ctx.directoryPath, 'truncate');
  createStubBin(ctx.directoryPath, 'mkfs.xfs');
  createStubBin(ctx.directoryPath, 'bun', 'exit 1');

  const result = await $`${process.execPath} ${ctx.scriptPath}`
    .env({ PATH: sudo.bin, RUNNER_TEMP: ctx.runnerTemp })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(1);

  expect(readFileSync(sudo.calls, 'utf8')).toEndWith(
    `sudo umount ${join(ctx.runnerTemp, 'small-fs')}\n`,
  );
});
