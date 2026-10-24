import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDockerBuildx } from './run-docker-build';

async function setupTest() {
  const directory = await mkdtemp(join(tmpdir(), 'run-docker-build-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return { directoryPath: directory };
}

test('#checkDockerBuildx answers yes for a docker whose buildx version succeeds', async () => {
  const ctx = await setupTest();

  const docker = join(ctx.directoryPath, 'docker');

  await writeFile(docker, '#!/bin/sh\n[ "$1 $2" = "buildx version" ]\n', { mode: 0o755 });

  expect(checkDockerBuildx(docker)).toBeTrue();
});

test('#checkDockerBuildx answers no for a docker without buildx', async () => {
  const ctx = await setupTest();

  const docker = join(ctx.directoryPath, 'docker');

  await writeFile(docker, '#!/bin/sh\necho "unknown command: docker buildx" >&2\nexit 1\n', {
    mode: 0o755,
  });

  expect(checkDockerBuildx(docker)).toBeFalse();
});

test('#checkDockerBuildx answers no when there is no docker at all', async () => {
  const ctx = await setupTest();

  expect(checkDockerBuildx(join(ctx.directoryPath, 'docker'))).toBeFalse();
});
