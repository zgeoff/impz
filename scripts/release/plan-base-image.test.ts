import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubBin } from '@impz/test-utils/create-stub-bin';
import { $ } from 'bun';
import { buildStubRegistryDocker } from '../test-utils/build-stub-registry-docker';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-plan-base-image-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  writeFileSync(join(directory, 'outputs'), '');
  mkdirSync(join(directory, 'tree', 'images', 'base'), { recursive: true });

  return {
    directoryPath: directory,
    tree: join(directory, 'tree'),
    outputs: join(directory, 'outputs'),
    scriptPath: join(import.meta.dir, 'plan-base-image.ts'),
  };
}

test('it pushes a tag the registry does not have', async () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubRegistryDocker({ kind: 'missing' }),
  );

  mkdirSync(join(ctx.tree, 'scripts', 'release'), { recursive: true });
  writeFileSync(join(ctx.tree, 'scripts', 'release', 'check-base-image.sh'), '');

  writeFileSync(
    join(ctx.tree, 'images', 'base', 'Dockerfile'),
    'FROM ubuntu\nARG DOCKER_CE_VERSION=5:29.8.2-1~ubuntu.24.04~noble\n',
  );

  const result = await $`bun ${ctx.scriptPath}`
    .env({
      ...process.env,
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      BASE_IMAGE: 'ghcr.io/zgeoff/imp-base',
      PUSH_TAG: '1.2.3',
      GITHUB_OUTPUT: ctx.outputs,
      GITHUB_REPOSITORY: 'zgeoff/impz',
      GITHUB_WORKSPACE: ctx.tree,
    })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);
  expect(readFileSync(ctx.outputs, 'utf8')).toBe('action=push\n');
});

test('it pushes a missing tag of a tree that keeps its check script in host/', async () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubRegistryDocker({ kind: 'missing' }),
  );

  mkdirSync(join(ctx.tree, 'host'));
  writeFileSync(join(ctx.tree, 'host', 'check-base-image.sh'), '');

  writeFileSync(
    join(ctx.tree, 'images', 'base', 'Dockerfile'),
    'FROM ubuntu\nARG DOCKER_CE_VERSION=5:29.8.2-1~ubuntu.24.04~noble\n',
  );

  const result = await $`bun ${ctx.scriptPath}`
    .env({
      ...process.env,
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      BASE_IMAGE: 'ghcr.io/zgeoff/imp-base',
      PUSH_TAG: '1.2.3',
      GITHUB_OUTPUT: ctx.outputs,
      GITHUB_REPOSITORY: 'zgeoff/impz',
      GITHUB_WORKSPACE: ctx.tree,
    })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);
  expect(readFileSync(ctx.outputs, 'utf8')).toBe('action=push\n');
});

test('it leaves an attested existing tag alone, with a notice', async () => {
  const ctx = setupTest();
  const digest = `sha256:${'0123456789abcdef'.repeat(4)}`;

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubRegistryDocker({ kind: 'found', stdout: digest }),
  );

  const gh = createStubBin(ctx.directoryPath, 'gh', 'exit 0');

  mkdirSync(join(ctx.tree, 'scripts', 'release'), { recursive: true });
  writeFileSync(join(ctx.tree, 'scripts', 'release', 'check-base-image.sh'), '');

  writeFileSync(
    join(ctx.tree, 'images', 'base', 'Dockerfile'),
    'FROM ubuntu\nARG DOCKER_CE_VERSION=5:29.8.2-1~ubuntu.24.04~noble\n',
  );

  const result = await $`bun ${ctx.scriptPath}`
    .env({
      ...process.env,
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      BASE_IMAGE: 'ghcr.io/zgeoff/imp-base',
      PUSH_TAG: '1.2.3',
      GITHUB_OUTPUT: ctx.outputs,
      GITHUB_REPOSITORY: 'zgeoff/impz',
      GITHUB_WORKSPACE: ctx.tree,
    })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);
  expect(readFileSync(ctx.outputs, 'utf8')).toBe('action=skip\n');

  expect(result.stdout.toString()).toBe(
    `::notice::ghcr.io/zgeoff/imp-base:1.2.3 exists already at ${digest}, attested; a published imp-base never moves, so this run leaves it alone\n`,
  );

  expect(readFileSync(gh.calls, 'utf8')).toInclude(
    `gh attestation verify oci://ghcr.io/zgeoff/imp-base@${digest} --repo zgeoff/impz\n`,
  );
});

test('it fails the job on an existing tag without an attestation, and plans nothing', async () => {
  const ctx = setupTest();
  const digest = `sha256:${'0123456789abcdef'.repeat(4)}`;

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubRegistryDocker({ kind: 'found', stdout: digest }),
  );

  createStubBin(ctx.directoryPath, 'gh', 'echo "no attestations found" >&2\nexit 1');
  mkdirSync(join(ctx.tree, 'scripts', 'release'), { recursive: true });
  writeFileSync(join(ctx.tree, 'scripts', 'release', 'check-base-image.sh'), '');

  writeFileSync(
    join(ctx.tree, 'images', 'base', 'Dockerfile'),
    'FROM ubuntu\nARG DOCKER_CE_VERSION=5:29.8.2-1~ubuntu.24.04~noble\n',
  );

  const result = await $`bun ${ctx.scriptPath}`
    .env({
      ...process.env,
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      BASE_IMAGE: 'ghcr.io/zgeoff/imp-base',
      PUSH_TAG: '1.2.3',
      GITHUB_OUTPUT: ctx.outputs,
      GITHUB_REPOSITORY: 'zgeoff/impz',
      GITHUB_WORKSPACE: ctx.tree,
    })
    .nothrow()
    .quiet();

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: `::error::ghcr.io/zgeoff/imp-base:1.2.3 exists at ${digest} with no attestation from zgeoff/impz; treat it as a possible compromise (docs/runbooks/releasing.md)\n`,
    stderr: 'no attestations found\n',
  });

  expect(readFileSync(ctx.outputs, 'utf8')).toBe('');
});

test('it fails the job on an existing tag whose digest is not a sha256', async () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubRegistryDocker({ kind: 'found', stdout: 'WARN: something\nsha256:abc' }),
  );

  createStubBin(ctx.directoryPath, 'gh', 'exit 0');
  mkdirSync(join(ctx.tree, 'scripts', 'release'), { recursive: true });
  writeFileSync(join(ctx.tree, 'scripts', 'release', 'check-base-image.sh'), '');

  writeFileSync(
    join(ctx.tree, 'images', 'base', 'Dockerfile'),
    'FROM ubuntu\nARG DOCKER_CE_VERSION=5:29.8.2-1~ubuntu.24.04~noble\n',
  );

  const result = await $`bun ${ctx.scriptPath}`
    .env({
      ...process.env,
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      BASE_IMAGE: 'ghcr.io/zgeoff/imp-base',
      PUSH_TAG: '1.2.3',
      GITHUB_OUTPUT: ctx.outputs,
      GITHUB_REPOSITORY: 'zgeoff/impz',
      GITHUB_WORKSPACE: ctx.tree,
    })
    .nothrow()
    .quiet();

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 1,
    stdout:
      '::error::ghcr.io/zgeoff/imp-base:1.2.3 exists, but the registry gave no valid digest: WARN: something\nsha256:abc\n',
  });

  expect(readFileSync(ctx.outputs, 'utf8')).toBe('');
});

test.each([
  ['a denied request', 'ERROR: failed to authorize: 403 Forbidden'],
  ['a missing blob', 'ERROR: blob sha256:abc not found'],
])('it fails the job, planning nothing, on %s from the registry', async (_reason, error) => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubRegistryDocker({ kind: 'failed', error }),
  );

  mkdirSync(join(ctx.tree, 'scripts', 'release'), { recursive: true });
  writeFileSync(join(ctx.tree, 'scripts', 'release', 'check-base-image.sh'), '');

  writeFileSync(
    join(ctx.tree, 'images', 'base', 'Dockerfile'),
    'FROM ubuntu\nARG DOCKER_CE_VERSION=5:29.8.2-1~ubuntu.24.04~noble\n',
  );

  const result = await $`bun ${ctx.scriptPath}`
    .env({
      ...process.env,
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      BASE_IMAGE: 'ghcr.io/zgeoff/imp-base',
      PUSH_TAG: '1.2.3',
      GITHUB_OUTPUT: ctx.outputs,
      GITHUB_REPOSITORY: 'zgeoff/impz',
      GITHUB_WORKSPACE: ctx.tree,
    })
    .nothrow()
    .quiet();

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: `cannot tell whether ghcr.io/zgeoff/imp-base:1.2.3 exists:\n${error}\n`,
  });

  expect(readFileSync(ctx.outputs, 'utf8')).toBe('');
});

test('it skips a release from before imp-base without asking the registry', async () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubRegistryDocker({ kind: 'missing' }),
  );

  writeFileSync(join(ctx.tree, 'images', 'base', 'Dockerfile'), 'FROM ubuntu:24.04\n');

  const result = await $`bun ${ctx.scriptPath}`
    .env({
      ...process.env,
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      BASE_IMAGE: 'ghcr.io/zgeoff/imp-base',
      PUSH_TAG: '1.2.3',
      GITHUB_OUTPUT: ctx.outputs,
      GITHUB_REPOSITORY: 'zgeoff/impz',
      GITHUB_WORKSPACE: ctx.tree,
    })
    .nothrow()
    .quiet();

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout:
      '::notice::this tree predates the published imp-base, so ghcr.io/zgeoff/imp-base:1.2.3 is not built\n',
  });

  expect(readFileSync(ctx.outputs, 'utf8')).toBe('action=skip\n');
  expect(readFileSync(docker.calls, 'utf8')).toBe('');
});

test('it skips a tree with the check script but an unpinned base image', async () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubRegistryDocker({ kind: 'missing' }),
  );

  mkdirSync(join(ctx.tree, 'host'));
  writeFileSync(join(ctx.tree, 'host', 'check-base-image.sh'), '');
  writeFileSync(join(ctx.tree, 'images', 'base', 'Dockerfile'), 'FROM ubuntu:24.04\n');

  const result = await $`bun ${ctx.scriptPath}`
    .env({
      ...process.env,
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      BASE_IMAGE: 'ghcr.io/zgeoff/imp-base',
      PUSH_TAG: '1.2.3',
      GITHUB_OUTPUT: ctx.outputs,
      GITHUB_REPOSITORY: 'zgeoff/impz',
      GITHUB_WORKSPACE: ctx.tree,
    })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);
  expect(readFileSync(ctx.outputs, 'utf8')).toBe('action=skip\n');
  expect(readFileSync(docker.calls, 'utf8')).toBe('');
});
