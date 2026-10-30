import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubBin } from '@impz/test-utils/create-stub-bin';
import { buildStubPushDocker } from './build-stub-push-docker';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-stub-push-docker-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
}

test('it prints what the registry gives for an inspect', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubPushDocker({ inspected: 'sha256:abc' }),
  );

  const result = Bun.spawnSync(
    ['docker', 'buildx', 'imagetools', 'inspect', 'ghcr.io/example/imp:1', '--format', '{{x}}'],
    { env: { PATH: docker.bin } },
  );

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: 'sha256:abc\n',
  });
});

test.each([
  ['push', ['docker', 'push', 'ghcr.io/example/imp:1']],
  ['tag', ['docker', 'tag', 'imp:1', 'ghcr.io/example/imp:1']],
])('it passes a %s', (_, command) => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubPushDocker({ inspected: 'sha256:abc' }),
  );

  expect(Bun.spawnSync(command, { env: { PATH: docker.bin } }).exitCode).toBe(0);
});

test('it refuses a push it is told to refuse', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubPushDocker({ inspected: 'sha256:abc', isPushRefused: true }),
  );

  const result = Bun.spawnSync(['docker', 'push', 'ghcr.io/example/imp:1'], {
    env: { PATH: docker.bin },
  });

  expect(result.exitCode).toBe(1);
});
