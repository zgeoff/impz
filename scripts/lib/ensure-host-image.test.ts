import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateEnv } from '@impz/test-utils/update-env';
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
    'case "$1 $2" in "image inspect") exit 1 ;; esac',
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
    'case "$1 $2" in "image inspect") exit 1 ;; esac',
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
  );

  expect(readFileSync(docker.calls, 'utf8').split('\n')).toStrictEqual([
    'docker image inspect imp-host:dev-imp-test',
    'docker build -q --provenance=false -t imp-host:dev-imp-test --label imp.worktree=/w/imp --target dev -f /w/imp/host/Dockerfile /w/imp',
    '',
  ]);
});

test('it builds nothing when the host image exists', async () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.directoryPath, 'docker');

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  await ensureHostImage(
    {
      root: '/w/imp',
      rootPhysical: '/w/imp',
      hostImage: 'imp-host:dev-imp-test',
      buildDir: '/w/imp/build',
    },
    'fake-machine-id',
  );

  expect(readFileSync(docker.calls, 'utf8')).toBe('docker image inspect imp-host:dev-imp-test\n');
});
