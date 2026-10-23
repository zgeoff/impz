import { expect, mock, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateEnv } from '@impz/test-utils/update-env';
import { createStubBin } from '../../scripts/test-utils/create-stub-bin';
import { removeTestContainer } from './remove-test-container';
import type { BootstrapRun } from './types';
import { wireBootstrapIO } from './wire-bootstrap-io';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-remove-test-container-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const writeStderr = mock();

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
    log: mock(),
  };

  return { directory, run, writeStderr };
}

test('it removes the container and forgets it once docker removes it', async () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.directory, 'docker');

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  ctx.run.state.container = 'imp-bootstrap-test-debian-4242';

  await removeTestContainer(ctx.run);

  expect(ctx.run.state.container).toBeNull();

  expect(readFileSync(docker.calls, 'utf8')).toEndWith(
    'docker rm -f -v imp-bootstrap-test-debian-4242\n',
  );
});

test('it fails and keeps the container when docker cannot remove it', async () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directory,
    'docker',
    [
      'case "$1" in',
      '  rm) echo "Error response from daemon: cannot remove container" >&2; exit 1 ;;',
      'esac',
    ].join('\n'),
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
