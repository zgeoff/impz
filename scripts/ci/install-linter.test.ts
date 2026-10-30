import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { createStubCurl } from '../test-utils/create-stub-curl';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-install-linter-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  mkdirSync(join(directory, 'temp'));
  writeFileSync(join(directory, 'path'), '');

  return {
    directoryPath: directory,
    runnerTemp: join(directory, 'temp'),
    githubPath: join(directory, 'path'),
    scriptPath: join(import.meta.dir, 'install-linter.ts'),
  };
}

test('it installs a linter released as a bare binary, once its sum matches, and puts it on the PATH', async () => {
  const ctx = setupTest();
  const release = join(ctx.directoryPath, 'shfmt');
  const binary = '#!/bin/sh\necho v3.14.1\n';

  writeFileSync(release, binary);

  const curl = createStubCurl(ctx.directoryPath, { source: release });

  const result = await $`bun ${ctx.scriptPath} shfmt`
    .env({
      ...process.env,
      PATH: `${curl.bin}:${process.env['PATH'] ?? ''}`,
      SHFMT_VERSION: 'v3.14.1',
      SHFMT_SHA256: new Bun.CryptoHasher('sha256').update(binary).digest('hex'),
      RUNNER_TEMP: ctx.runnerTemp,
      GITHUB_PATH: ctx.githubPath,
    })
    .nothrow()
    .quiet();

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: 'v3.14.1\n',
  });

  expect(readFileSync(curl.calls, 'utf8')).toInclude(
    'https://github.com/mvdan/sh/releases/download/v3.14.1/shfmt_v3.14.1_linux_amd64',
  );

  expect(readFileSync(ctx.githubPath, 'utf8')).toBe(`${join(ctx.runnerTemp, 'bin')}\n`);
});

test('it installs a linter from its release archive', async () => {
  const ctx = setupTest();
  const archive = join(ctx.directoryPath, 'actionlint.tar.gz');

  mkdirSync(join(ctx.directoryPath, 'release'));

  writeFileSync(join(ctx.directoryPath, 'release', 'actionlint'), '#!/bin/sh\necho 1.7.12\n', {
    mode: 0o755,
  });

  writeFileSync(join(ctx.directoryPath, 'release', 'README.md'), 'actionlint\n');

  await $`tar -czf ${archive} -C ${join(ctx.directoryPath, 'release')} actionlint README.md`.quiet();

  const curl = createStubCurl(ctx.directoryPath, { source: archive });

  const result = await $`bun ${ctx.scriptPath} actionlint`
    .env({
      ...process.env,
      PATH: `${curl.bin}:${process.env['PATH'] ?? ''}`,
      ACTIONLINT_VERSION: '1.7.12',
      ACTIONLINT_SHA256: new Bun.CryptoHasher('sha256').update(readFileSync(archive)).digest('hex'),
      RUNNER_TEMP: ctx.runnerTemp,
      GITHUB_PATH: ctx.githubPath,
    })
    .nothrow()
    .quiet();

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: '1.7.12\n',
  });

  expect(readFileSync(curl.calls, 'utf8')).toInclude(
    'https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz',
  );
});

test('it installs nothing from a download whose sum differs from the pinned one', async () => {
  const ctx = setupTest();
  const release = join(ctx.directoryPath, 'hadolint');
  const binary = '#!/bin/sh\necho tampered\n';

  writeFileSync(release, binary);

  const curl = createStubCurl(ctx.directoryPath, { source: release });

  const result = await $`bun ${ctx.scriptPath} hadolint`
    .env({
      ...process.env,
      PATH: `${curl.bin}:${process.env['PATH'] ?? ''}`,
      HADOLINT_VERSION: 'v2.15.1',
      HADOLINT_SHA256: '0'.repeat(64),
      RUNNER_TEMP: ctx.runnerTemp,
      GITHUB_PATH: ctx.githubPath,
    })
    .nothrow()
    .quiet();

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: `hadolint v2.15.1 has sha256 ${new Bun.CryptoHasher('sha256').update(binary).digest('hex')}, want ${'0'.repeat(64)}\n`,
  });

  expect(existsSync(join(ctx.runnerTemp, 'bin', 'hadolint'))).toBeFalse();
  expect(readFileSync(ctx.githubPath, 'utf8')).toBe('');
});

test('it installs nothing when curl fails, even after writing the right bytes', async () => {
  const ctx = setupTest();
  const release = join(ctx.directoryPath, 'shfmt');
  const binary = '#!/bin/sh\necho v3.14.1\n';

  writeFileSync(release, binary);

  const curl = createStubCurl(ctx.directoryPath, { source: release, exitCode: 22 });

  const result = await $`bun ${ctx.scriptPath} shfmt`
    .env({
      ...process.env,
      PATH: `${curl.bin}:${process.env['PATH'] ?? ''}`,
      SHFMT_VERSION: 'v3.14.1',
      SHFMT_SHA256: new Bun.CryptoHasher('sha256').update(binary).digest('hex'),
      RUNNER_TEMP: ctx.runnerTemp,
      GITHUB_PATH: ctx.githubPath,
    })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(1);
  expect(existsSync(join(ctx.runnerTemp, 'bin', 'shfmt'))).toBeFalse();
  expect(readFileSync(ctx.githubPath, 'utf8')).toBe('');
});

test('it refuses a linter it does not pin, with its usage', async () => {
  const ctx = setupTest();

  const result = await $`bun ${ctx.scriptPath} eslint`
    .env({ ...process.env, RUNNER_TEMP: ctx.runnerTemp, GITHUB_PATH: ctx.githubPath })
    .nothrow()
    .quiet();

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 2,
    stderr: 'usage: install-linter.ts <shellcheck|shfmt|actionlint|zizmor|hadolint>\n',
  });
});

test('it refuses a second linter, and installs nothing', async () => {
  const ctx = setupTest();

  const result = await $`bun ${ctx.scriptPath} shellcheck shfmt`
    .env({ ...process.env, RUNNER_TEMP: ctx.runnerTemp, GITHUB_PATH: ctx.githubPath })
    .nothrow()
    .quiet();

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 2,
    stderr: 'usage: install-linter.ts <shellcheck|shfmt|actionlint|zizmor|hadolint>\n',
  });

  expect(readFileSync(ctx.githubPath, 'utf8')).toBe('');
});
