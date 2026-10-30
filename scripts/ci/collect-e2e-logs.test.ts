import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubBin } from '@impz/test-utils/create-stub-bin';
import { $ } from 'bun';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-collect-e2e-logs-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  mkdirSync(join(directory, 'checkout'));

  return {
    directoryPath: directory,
    checkout: join(directory, 'checkout'),
    scriptPath: join(import.meta.dir, 'collect-e2e-logs.ts'),
  };
}

test("it writes the container's output and errors to impd.log, and shows the disk use", async () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    'echo "impd listening"\necho "imp woke" >&2',
  );

  createStubBin(ctx.directoryPath, 'du');
  createStubBin(ctx.directoryPath, 'df');

  const result = await $`${process.execPath} ${ctx.scriptPath} docker imp-dev`
    .cwd(ctx.checkout)
    .env({ PATH: docker.bin, IMP_DEV_DATA: '/mnt/imp-e2e' })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);

  expect(readFileSync(join(ctx.checkout, '.cache', 'e2e', 'impd.log'), 'utf8')).toBe(
    'impd listening\nimp woke\n',
  );

  expect(readFileSync(docker.calls, 'utf8')).toBe(
    ['docker logs imp-dev', 'du -h /mnt/imp-e2e/imp.xfs', 'df -h / /mnt', ''].join('\n'),
  );
});

test('it takes back the logs folder that the Podman proof left as root, and reads the container as root', async () => {
  const ctx = setupTest();

  const sudo = createStubBin(
    ctx.directoryPath,
    'sudo',
    '[ "$1" = podman ] && echo "impd under podman"\nexit 0',
  );

  const owner = `${String(process.getuid?.())}:${String(process.getgid?.())}`;

  createStubBin(ctx.directoryPath, 'df');

  const result = await $`${process.execPath} ${ctx.scriptPath} podman imp-dev`
    .cwd(ctx.checkout)
    .env({ PATH: sudo.bin })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);

  expect(readFileSync(join(ctx.checkout, '.cache', 'e2e', 'impd.log'), 'utf8')).toBe(
    'impd under podman\n',
  );

  expect(readFileSync(sudo.calls, 'utf8')).toBe(
    [
      'sudo mkdir -p .cache/e2e',
      `sudo chown -R ${owner} .cache/e2e`,
      'sudo podman logs imp-dev',
      'df -h / /mnt',
      '',
    ].join('\n'),
  );
});

test("it keeps the zfs host test's logs and summary, and adds the container's output after them", async () => {
  const ctx = setupTest();
  const zfsDir = join(ctx.directoryPath, 'imp-zfs');
  const docker = createStubBin(ctx.directoryPath, 'docker', 'echo "container output"');

  createStubBin(ctx.directoryPath, 'df');
  mkdirSync(zfsDir);
  writeFileSync(join(zfsDir, 'impd.log'), 'impd started\n');
  writeFileSync(join(zfsDir, 'summary.txt'), 'pool: 3 s\n');

  const result = await $`${process.execPath} ${ctx.scriptPath} docker imp-zfs`
    .cwd(ctx.checkout)
    .env({ PATH: docker.bin, IMP_ZFS_TEST_DIR: zfsDir })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);

  expect(readdirSync(join(ctx.checkout, '.cache', 'e2e')).toSorted()).toStrictEqual([
    'impd.log',
    'summary.txt',
  ]);

  expect(readFileSync(join(ctx.checkout, '.cache', 'e2e', 'impd.log'), 'utf8')).toBe(
    'impd started\ncontainer output\n',
  );
});

test('it passes when no container is left to read', async () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    'echo "Error: No such container: imp-dev" >&2\nexit 1',
  );

  createStubBin(ctx.directoryPath, 'du', 'exit 1');
  createStubBin(ctx.directoryPath, 'df', 'exit 1');

  const result = await $`${process.execPath} ${ctx.scriptPath} docker imp-dev`
    .cwd(ctx.checkout)
    .env({ PATH: docker.bin, IMP_DEV_DATA: '/mnt/imp-e2e' })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);
});
