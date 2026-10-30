import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubBin } from '@impz/test-utils/create-stub-bin';
import { $ } from 'bun';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-push-image-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  writeFileSync(join(directory, 'outputs'), '');

  return {
    directoryPath: directory,
    outputs: join(directory, 'outputs'),
    scriptPath: join(import.meta.dir, 'push-image.ts'),
  };
}

test('it pushes a release under its version and outputs the digest the registry gives', async () => {
  const ctx = setupTest();
  const digest = `sha256:${'0123456789abcdef'.repeat(4)}`;

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    `[ "$1 $2" = "buildx imagetools" ] && echo ${digest}\nexit 0`,
  );

  const result = await $`bun ${ctx.scriptPath}`
    .env({
      ...process.env,
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMAGE: 'ghcr.io/zgeoff/imp-host',
      BUILT_TAG: '2.0.1',
      PUSH_TAG: '2.0.1',
      GITHUB_OUTPUT: ctx.outputs,
    })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);
  expect(readFileSync(ctx.outputs, 'utf8')).toBe(`digest=${digest}\n`);

  expect(readFileSync(docker.calls, 'utf8')).toBe(
    [
      'docker push ghcr.io/zgeoff/imp-host:2.0.1',
      'docker buildx imagetools inspect ghcr.io/zgeoff/imp-host:2.0.1 --format {{.Manifest.Digest}}',
      '',
    ].join('\n'),
  );
});

test('it tags a dry run under its push tag before it pushes', async () => {
  const ctx = setupTest();
  const digest = `sha256:${'0123456789abcdef'.repeat(4)}`;

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    `[ "$1 $2" = "buildx imagetools" ] && echo ${digest}\nexit 0`,
  );

  const result = await $`bun ${ctx.scriptPath}`
    .env({
      ...process.env,
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMAGE: 'ghcr.io/zgeoff/imp-host',
      BUILT_TAG: '2.0.1',
      PUSH_TAG: 'dryrun-0123456789ab',
      GITHUB_OUTPUT: ctx.outputs,
    })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);

  expect(readFileSync(docker.calls, 'utf8')).toBe(
    [
      'docker tag ghcr.io/zgeoff/imp-host:2.0.1 ghcr.io/zgeoff/imp-host:dryrun-0123456789ab',
      'docker push ghcr.io/zgeoff/imp-host:dryrun-0123456789ab',
      'docker buildx imagetools inspect ghcr.io/zgeoff/imp-host:dryrun-0123456789ab --format {{.Manifest.Digest}}',
      '',
    ].join('\n'),
  );
});

test('it fails, outputting no digest, when the registry gives no valid digest', async () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    '[ "$1 $2" = "buildx imagetools" ] && echo "<no value>"\nexit 0',
  );

  const result = await $`bun ${ctx.scriptPath}`
    .env({
      ...process.env,
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMAGE: 'ghcr.io/zgeoff/imp-base',
      BUILT_TAG: '2.0.1',
      PUSH_TAG: '2.0.1',
      GITHUB_OUTPUT: ctx.outputs,
    })
    .nothrow()
    .quiet();

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 1,
    stdout:
      '::error::the registry gave no valid digest for ghcr.io/zgeoff/imp-base:2.0.1: <no value>\n',
  });

  expect(readFileSync(ctx.outputs, 'utf8')).toBe('');
});

test('it fails, outputting nothing, when the push fails', async () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.directoryPath, 'docker', '[ "$1" = push ] && exit 1\nexit 0');

  const result = await $`bun ${ctx.scriptPath}`
    .env({
      ...process.env,
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMAGE: 'ghcr.io/zgeoff/imp-host',
      BUILT_TAG: '2.0.1',
      PUSH_TAG: '2.0.1',
      GITHUB_OUTPUT: ctx.outputs,
    })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(1);
  expect(readFileSync(ctx.outputs, 'utf8')).toBe('');
  expect(readFileSync(docker.calls, 'utf8')).toBe('docker push ghcr.io/zgeoff/imp-host:2.0.1\n');
});
