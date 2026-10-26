import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateEnv } from '@impz/test-utils/update-env';
import { buildStubDevHostDocker } from '../test-utils/build-stub-dev-host-docker';
import { createStubBin } from '../test-utils/create-stub-bin';
import { ensureHostImage } from './ensure-host-image.ts';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-host-image-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
}

test('it builds the host image, labelled with the checkout and machine, when it is missing', async () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({ containers: {}, hasImage: false }),
  );

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  await ensureHostImage(
    {
      root: '/w/imp',
      rootPhysical: '/w/real/imp',
      hostImage: 'imp-host:dev-imp-test',
      buildDir: '/w/imp/build',
    },
    'fake-machine-id',
    'docker',
  );

  expect(readFileSync(docker.calls, 'utf8').split('\n')).toStrictEqual([
    'docker image inspect imp-host:dev-imp-test',
    'docker build -q --provenance=false -t imp-host:dev-imp-test --label imp.worktree=/w/real/imp --label imp.machine=fake-machine-id --target dev -f /w/imp/host/Dockerfile /w/imp',
    '',
  ]);
});

test('it leaves the machine label off without a machine id, so prune never touches the image', async () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({ containers: {}, hasImage: false }),
  );

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  await ensureHostImage(
    {
      root: '/w/imp',
      rootPhysical: '/w/imp',
      hostImage: 'imp-host:dev-imp-test',
      buildDir: '/w/imp/build',
    },
    '',
    'docker',
  );

  expect(readFileSync(docker.calls, 'utf8').split('\n')).toStrictEqual([
    'docker image inspect imp-host:dev-imp-test',
    'docker build -q --provenance=false -t imp-host:dev-imp-test --label imp.worktree=/w/imp --target dev -f /w/imp/host/Dockerfile /w/imp',
    '',
  ]);
});

test('it builds nothing when the host image exists', async () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({ containers: {}, hasImage: true }),
  );

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  await ensureHostImage(
    {
      root: '/w/imp',
      rootPhysical: '/w/imp',
      hostImage: 'imp-host:dev-imp-test',
      buildDir: '/w/imp/build',
    },
    'fake-machine-id',
    'docker',
  );

  expect(readFileSync(docker.calls, 'utf8')).toBe('docker image inspect imp-host:dev-imp-test\n');
});

test('it builds nothing under podman when podman holds the host image', async () => {
  const ctx = setupTest();
  const stub = buildStubDevHostDocker({ containers: {}, hasImage: true });
  const podman = createStubBin(ctx.directoryPath, 'podman', stub);

  createStubBin(ctx.directoryPath, 'docker', stub);
  updateEnv('PATH', `${podman.bin}:${process.env['PATH'] ?? ''}`);

  await ensureHostImage(
    {
      root: '/w/imp',
      rootPhysical: '/w/imp',
      hostImage: 'imp-host:dev-imp-test',
      buildDir: '/w/imp/build',
    },
    'fake-machine-id',
    'podman',
  );

  expect(readFileSync(podman.calls, 'utf8')).toBe('podman image exists imp-host:dev-imp-test\n');
});

test('it refuses under podman without the host image, naming the command that loads it', () => {
  const ctx = setupTest();
  const stub = buildStubDevHostDocker({ containers: {}, hasImage: false });
  const podman = createStubBin(ctx.directoryPath, 'podman', stub);

  createStubBin(ctx.directoryPath, 'docker', stub);
  updateEnv('PATH', `${podman.bin}:${process.env['PATH'] ?? ''}`);

  const ensured = ensureHostImage(
    {
      root: '/w/imp',
      rootPhysical: '/w/imp',
      hostImage: 'imp-host:dev-imp-test',
      buildDir: '/w/imp/build',
    },
    'fake-machine-id',
    'podman',
  );

  expect(ensured).rejects.toThrowWithMessage(
    Error,
    'podman has no imp-host:dev-imp-test image; load it with: docker save imp-host:dev-imp-test | podman load',
  );
});
