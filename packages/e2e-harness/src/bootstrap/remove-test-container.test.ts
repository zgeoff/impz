import { expect, mock, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubBin } from '@impz/test-utils/create-stub-bin';
import { updateEnv } from '@impz/test-utils/update-env';
import { buildStubBootstrapDocker } from '../../../../scripts/test-utils/build-stub-bootstrap-docker';
import { removeTestContainer } from './remove-test-container';
import type { BootstrapRun } from './types';
import { wireBootstrapIO } from './wire-bootstrap-io';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-remove-test-container-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const writeStderr = mock<(text: string) => void>(() => {});

  const run: BootstrapRun = {
    io: { ...wireBootstrapIO(), writeStderr },
    root: '/repo',
    args: { image: null, stub: true, health: false, keep: false, zfs: false, distros: ['debian'] },
    image: 'imp-host-stub:test',
    work: directory,
    fakeKey: 'fake-authkey-4242-1',
    runID: 4242,
    zfsPool: 'impt4242',
    state: { container: null },
    log: mock(() => {}),
  };

  return { directory, run, writeStderr };
}

test('it tears down the pool and loop devices in the container before docker removes it, then forgets it', async () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.directory, 'docker', buildStubBootstrapDocker({}));

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  ctx.run.state.container = 'imp-bootstrap-test-debian-4242';

  await removeTestContainer(ctx.run);

  expect(ctx.run.state.container).toBeNull();

  expect(readFileSync(docker.calls, 'utf8')).toMatch(
    /^docker exec imp-bootstrap-test-debian-4242 bash -c .*zpool destroy -f "\$pool".*losetup -d "\$dev".* teardown impt4242 \/var\/imp\.xfs \/var\/disk-empty\.img \/var\/disk-ext4\.img\ndocker rm -f -v imp-bootstrap-test-debian-4242\n$/su,
  );
});

test('it warns and still removes the container when the teardown in it fails', async () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directory,
    'docker',
    buildStubBootstrapDocker({ teardown: 'fails' }),
  );

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  ctx.run.state.container = 'imp-bootstrap-test-debian-4242';

  await removeTestContainer(ctx.run);

  expect(ctx.run.state.container).toBeNull();

  expect(ctx.writeStderr.mock.calls).toStrictEqual([
    ['teardown: zpool destroy failed: pool is busy\n'],
    [
      'test-bootstrap: WARNING: teardown in imp-bootstrap-test-debian-4242 failed; check losetup -l\n',
    ],
  ]);

  expect(readFileSync(docker.calls, 'utf8')).toEndWith(
    '\ndocker rm -f -v imp-bootstrap-test-debian-4242\n',
  );
});

test('it fails and keeps the container when docker cannot remove it', async () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directory,
    'docker',
    buildStubBootstrapDocker({ removal: 'fails' }),
  );

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  ctx.run.state.container = 'imp-bootstrap-test-debian-4242';

  const failure = await removeTestContainer(ctx.run).then(
    () => null,
    (error: unknown) => error,
  );

  expect(failure).toMatchObject({
    name: 'BootstrapTestError',
    message: 'docker rm -f -v imp-bootstrap-test-debian-4242 failed; the container stays',
  });

  expect(ctx.run.state.container).toBe('imp-bootstrap-test-debian-4242');

  expect(ctx.writeStderr).toHaveBeenCalledExactlyOnceWith(
    'Error response from daemon: cannot remove container\n',
  );
});
