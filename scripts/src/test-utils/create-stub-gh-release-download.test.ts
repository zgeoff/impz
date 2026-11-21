import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatStubCalls } from '@impz/shared/test-utils/format-stub-calls';
import { readStubCalls } from '@zgeoff/testing/bin';
import { createStubGhReleaseDownload } from './create-stub-gh-release-download';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-stub-gh-release-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
}

test('it writes the source file to the path after --output and exits 0', () => {
  const ctx = setupTest();
  const source = join(ctx.directoryPath, 'lint.tar.gz');
  const output = join(ctx.directoryPath, 'download');

  writeFileSync(source, 'archive');
  createStubGhReleaseDownload(ctx.directoryPath, { source });

  const result = Bun.spawnSync([
    join(ctx.directoryPath, 'gh'),
    'release',
    'download',
    'v1.2.3',
    '--repo',
    'example/lint',
    '--pattern',
    'lint_1.2.3_linux_amd64.tar.gz',
    '--output',
    output,
  ]);

  expect(result.exitCode).toBe(0);
  expect(readFileSync(output, 'utf8')).toBe('archive');
});

test('it writes what it had and exits with the code it was given for a failed download', () => {
  const ctx = setupTest();
  const source = join(ctx.directoryPath, 'partial');
  const output = join(ctx.directoryPath, 'download');

  writeFileSync(source, 'partial');
  createStubGhReleaseDownload(ctx.directoryPath, { source, exitCode: 1 });

  const result = Bun.spawnSync([
    join(ctx.directoryPath, 'gh'),
    'release',
    'download',
    'v1.2.3',
    '--output',
    output,
  ]);

  expect(result.exitCode).toBe(1);
  expect(readFileSync(output, 'utf8')).toBe('partial');
});

test.each([
  ['a command other than release download', ['repo', 'clone', 'example/lint']],
  ['a release download without --output', ['release', 'download', 'v1.2.3']],
])('it fails as a usage error for %s', (_label, args) => {
  const ctx = setupTest();
  const source = join(ctx.directoryPath, 'lint');

  writeFileSync(source, 'binary');
  createStubGhReleaseDownload(ctx.directoryPath, { source });

  expect(Bun.spawnSync([join(ctx.directoryPath, 'gh'), ...args]).exitCode).toBe(2);
});

test('it logs each call with its arguments', () => {
  const ctx = setupTest();
  const source = join(ctx.directoryPath, 'lint');

  writeFileSync(source, 'binary');
  createStubGhReleaseDownload(ctx.directoryPath, { source });

  Bun.spawnSync([
    join(ctx.directoryPath, 'gh'),
    'release',
    'download',
    'v1.2.3',
    '--output',
    join(ctx.directoryPath, 'out'),
  ]);

  expect(formatStubCalls(readStubCalls(ctx.directoryPath))).toBe(
    `gh release download v1.2.3 --output ${ctx.directoryPath}/out\n`,
  );
});
