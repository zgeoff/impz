import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubBin } from '@impz/test-utils/create-stub-bin';
import { formatShellWord } from '@impz/test-utils/format-shell-word';
import { $ } from 'bun';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-tag-latest-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  writeFileSync(join(directory, 'outputs'), '');

  return {
    directoryPath: directory,
    outputs: join(directory, 'outputs'),
    newest: join(directory, 'newest'),
    scriptPath: join(import.meta.dir, 'tag-latest.ts'),
  };
}

test('it leaves latest on the newer release when the older run holds the lock after the newer run', async () => {
  const ctx = setupTest();
  const gh = createStubBin(ctx.directoryPath, 'gh', `cat ${formatShellWord(ctx.newest)}`);

  createStubBin(ctx.directoryPath, 'docker', 'exit 0');
  writeFileSync(ctx.newest, 'v1.0.4\n');

  const env = {
    ...process.env,
    PATH: `${gh.bin}:${process.env['PATH'] ?? ''}`,
    IMAGE: 'ghcr.io/zgeoff/imp-host',
    GITHUB_OUTPUT: ctx.outputs,
    GITHUB_REPOSITORY: 'zgeoff/impz',
  };

  const newer = await $`bun ${ctx.scriptPath}`
    .env({ ...env, TAG: 'v1.0.4', VERSION: '1.0.4' })
    .nothrow()
    .quiet();

  const older = await $`bun ${ctx.scriptPath}`
    .env({ ...env, TAG: 'v1.0.3', VERSION: '1.0.3' })
    .nothrow()
    .quiet();

  expect(newer.exitCode).toBe(0);
  expect(older.exitCode).toBe(0);

  expect(readFileSync(gh.calls, 'utf8')).toBe(
    [
      'gh release view --repo zgeoff/impz --json tagName --jq .tagName',
      'docker buildx imagetools create -t ghcr.io/zgeoff/imp-host:latest ghcr.io/zgeoff/imp-host:1.0.4',
      'gh release view --repo zgeoff/impz --json tagName --jq .tagName',
      '',
    ].join('\n'),
  );
});

test('it leaves latest on the newer release when the older run holds the lock first, after the newer release is out', async () => {
  const ctx = setupTest();
  const gh = createStubBin(ctx.directoryPath, 'gh', `cat ${formatShellWord(ctx.newest)}`);

  createStubBin(ctx.directoryPath, 'docker', 'exit 0');
  writeFileSync(ctx.newest, 'v1.0.4\n');

  const env = {
    ...process.env,
    PATH: `${gh.bin}:${process.env['PATH'] ?? ''}`,
    IMAGE: 'ghcr.io/zgeoff/imp-host',
    GITHUB_OUTPUT: ctx.outputs,
    GITHUB_REPOSITORY: 'zgeoff/impz',
  };

  const older = await $`bun ${ctx.scriptPath}`
    .env({ ...env, TAG: 'v1.0.3', VERSION: '1.0.3' })
    .nothrow()
    .quiet();

  const newer = await $`bun ${ctx.scriptPath}`
    .env({ ...env, TAG: 'v1.0.4', VERSION: '1.0.4' })
    .nothrow()
    .quiet();

  expect(older.exitCode).toBe(0);
  expect(newer.exitCode).toBe(0);

  expect(readFileSync(gh.calls, 'utf8')).toBe(
    [
      'gh release view --repo zgeoff/impz --json tagName --jq .tagName',
      'gh release view --repo zgeoff/impz --json tagName --jq .tagName',
      'docker buildx imagetools create -t ghcr.io/zgeoff/imp-host:latest ghcr.io/zgeoff/imp-host:1.0.4',
      '',
    ].join('\n'),
  );
});

test('it moves latest forward when the older run holds the lock before the newer release is out', async () => {
  const ctx = setupTest();
  const gh = createStubBin(ctx.directoryPath, 'gh', `cat ${formatShellWord(ctx.newest)}`);

  createStubBin(ctx.directoryPath, 'docker', 'exit 0');
  writeFileSync(ctx.newest, 'v1.0.3\n');

  const env = {
    ...process.env,
    PATH: `${gh.bin}:${process.env['PATH'] ?? ''}`,
    IMAGE: 'ghcr.io/zgeoff/imp-host',
    GITHUB_OUTPUT: ctx.outputs,
    GITHUB_REPOSITORY: 'zgeoff/impz',
  };

  const older = await $`bun ${ctx.scriptPath}`
    .env({ ...env, TAG: 'v1.0.3', VERSION: '1.0.3' })
    .nothrow()
    .quiet();

  writeFileSync(ctx.newest, 'v1.0.4\n');

  const newer = await $`bun ${ctx.scriptPath}`
    .env({ ...env, TAG: 'v1.0.4', VERSION: '1.0.4' })
    .nothrow()
    .quiet();

  expect(older.exitCode).toBe(0);
  expect(newer.exitCode).toBe(0);

  expect(readFileSync(gh.calls, 'utf8')).toBe(
    [
      'gh release view --repo zgeoff/impz --json tagName --jq .tagName',
      'docker buildx imagetools create -t ghcr.io/zgeoff/imp-host:latest ghcr.io/zgeoff/imp-host:1.0.3',
      'gh release view --repo zgeoff/impz --json tagName --jq .tagName',
      'docker buildx imagetools create -t ghcr.io/zgeoff/imp-host:latest ghcr.io/zgeoff/imp-host:1.0.4',
      '',
    ].join('\n'),
  );
});

test('it tells the formula and npm that a release behind the newest is not the newest', async () => {
  const ctx = setupTest();
  const gh = createStubBin(ctx.directoryPath, 'gh', 'echo v1.0.4');

  createStubBin(ctx.directoryPath, 'docker', 'exit 0');

  const result = await $`bun ${ctx.scriptPath}`
    .env({
      ...process.env,
      PATH: `${gh.bin}:${process.env['PATH'] ?? ''}`,
      IMAGE: 'ghcr.io/zgeoff/imp-host',
      TAG: 'v1.0.3',
      VERSION: '1.0.3',
      GITHUB_OUTPUT: ctx.outputs,
      GITHUB_REPOSITORY: 'zgeoff/impz',
    })
    .nothrow()
    .quiet();

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: 'v1.0.3 is not the newest release (v1.0.4); latest stays\n',
  });

  expect(readFileSync(ctx.outputs, 'utf8')).toBe('newest_tag=v1.0.4\nis_newest=false\n');
});

test('it tells the formula and npm that the newest release is the newest', async () => {
  const ctx = setupTest();
  const gh = createStubBin(ctx.directoryPath, 'gh', 'echo v1.0.4');

  createStubBin(ctx.directoryPath, 'docker', 'exit 0');

  const result = await $`bun ${ctx.scriptPath}`
    .env({
      ...process.env,
      PATH: `${gh.bin}:${process.env['PATH'] ?? ''}`,
      IMAGE: 'ghcr.io/zgeoff/imp-host',
      TAG: 'v1.0.4',
      VERSION: '1.0.4',
      GITHUB_OUTPUT: ctx.outputs,
      GITHUB_REPOSITORY: 'zgeoff/impz',
    })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);
  expect(readFileSync(ctx.outputs, 'utf8')).toBe('newest_tag=v1.0.4\nis_newest=true\n');
});

test('it fails the job, moving nothing, when the newest release cannot be read', async () => {
  const ctx = setupTest();
  const gh = createStubBin(ctx.directoryPath, 'gh', 'echo "HTTP 502" >&2; exit 1');

  createStubBin(ctx.directoryPath, 'docker', 'exit 0');

  const result = await $`bun ${ctx.scriptPath}`
    .env({
      ...process.env,
      PATH: `${gh.bin}:${process.env['PATH'] ?? ''}`,
      IMAGE: 'ghcr.io/zgeoff/imp-host',
      TAG: 'v1.0.4',
      VERSION: '1.0.4',
      GITHUB_OUTPUT: ctx.outputs,
      GITHUB_REPOSITORY: 'zgeoff/impz',
    })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(1);
  expect(readFileSync(ctx.outputs, 'utf8')).toBe('');

  expect(readFileSync(gh.calls, 'utf8')).toBe(
    'gh release view --repo zgeoff/impz --json tagName --jq .tagName\n',
  );
});
