import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatStubCalls } from '@impz/shared/test-utils/format-stub-calls';
import { updateEnv } from '@zgeoff/testing';
import { createStubBin, readStubCalls } from '@zgeoff/testing/bin';
import { buildStubDevHostDocker } from '../test-utils/build-stub-dev-host-docker';
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

  createStubBin(ctx.directoryPath, 'docker', {
    script: buildStubDevHostDocker({ containers: {}, hasImage: false }),
  });

  updateEnv('PATH', `${ctx.directoryPath}:${process.env['PATH'] ?? ''}`);

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

  expect(formatStubCalls(readStubCalls(ctx.directoryPath)).split('\n')).toStrictEqual([
    'docker image inspect imp-host:dev-imp-test',
    'docker build -q --provenance=false -t imp-host:dev-imp-test --label imp.worktree=/w/real/imp --label imp.machine=fake-machine-id --target dev -f /w/imp/host/Dockerfile /w/imp',
    '',
  ]);
});

test('it leaves the machine label off without a machine id, so prune never touches the image', async () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'docker', {
    script: buildStubDevHostDocker({ containers: {}, hasImage: false }),
  });

  updateEnv('PATH', `${ctx.directoryPath}:${process.env['PATH'] ?? ''}`);

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

  expect(formatStubCalls(readStubCalls(ctx.directoryPath)).split('\n')).toStrictEqual([
    'docker image inspect imp-host:dev-imp-test',
    'docker build -q --provenance=false -t imp-host:dev-imp-test --label imp.worktree=/w/imp --target dev -f /w/imp/host/Dockerfile /w/imp',
    '',
  ]);
});

test('it builds nothing when the host image exists', async () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'docker', {
    script: buildStubDevHostDocker({ containers: {}, hasImage: true }),
  });

  updateEnv('PATH', `${ctx.directoryPath}:${process.env['PATH'] ?? ''}`);

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

  expect(formatStubCalls(readStubCalls(ctx.directoryPath))).toBe(
    'docker image inspect imp-host:dev-imp-test\n',
  );
});

test('it builds nothing under podman when podman holds the host image', async () => {
  const ctx = setupTest();
  const stub = buildStubDevHostDocker({ containers: {}, hasImage: true });

  createStubBin(ctx.directoryPath, 'podman', { script: `#!/bin/bash\n${stub}` });
  createStubBin(ctx.directoryPath, 'docker', { script: `#!/bin/bash\n${stub}` });
  updateEnv('PATH', `${ctx.directoryPath}:${process.env['PATH'] ?? ''}`);

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

  expect(formatStubCalls(readStubCalls(ctx.directoryPath))).toBe(
    'podman image exists imp-host:dev-imp-test\n',
  );
});

test('it refuses under podman without the host image, naming the command that loads it', () => {
  const ctx = setupTest();
  const stub = buildStubDevHostDocker({ containers: {}, hasImage: false });

  createStubBin(ctx.directoryPath, 'podman', { script: `#!/bin/bash\n${stub}` });
  createStubBin(ctx.directoryPath, 'docker', { script: `#!/bin/bash\n${stub}` });
  updateEnv('PATH', `${ctx.directoryPath}:${process.env['PATH'] ?? ''}`);

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
