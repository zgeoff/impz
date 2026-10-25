import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubBootstrapDocker } from './build-stub-bootstrap-docker';
import { createStubBin } from './create-stub-bin';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-bootstrap-docker-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return {
    directoryPath: directory,
  };
}

test('it inspects the imp-host container of an older release', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubBootstrapDocker({ hostContainer: 'present' }),
  );

  const result = Bun.spawnSync([join(docker.bin, 'docker'), 'container', 'inspect', 'imp-host']);

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: '[{"Name": "/imp-host"}]\n',
  });
});

test('it fails the inspect of the imp-host container when Docker runs none', () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.directoryPath, 'docker', buildStubBootstrapDocker({}));
  const result = Bun.spawnSync([join(docker.bin, 'docker'), 'container', 'inspect', 'imp-host']);

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: 'Error response from daemon: No such container: imp-host\n',
  });
});

test('it runs the teardown in a test container and removes the container', () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.directoryPath, 'docker', buildStubBootstrapDocker({}));

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      String.raw`docker exec imp-test-1 bash -c $'zpool destroy "$1"\n' teardown impt1 /var/imp.xfs; echo $?; docker rm -f -v imp-test-1; echo $?`,
    ],
    { env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect({ stdout: result.stdout.toString(), stderr: result.stderr.toString() }).toStrictEqual({
    stdout: '0\n0\n',
    stderr: '',
  });
});

test('it fails the teardown in a test container when told to', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubBootstrapDocker({ teardown: 'fails' }),
  );

  const result = Bun.spawnSync([
    join(docker.bin, 'docker'),
    'exec',
    'imp-test-1',
    'bash',
    '-c',
    'zpool destroy "$1"\n',
    'teardown',
    'impt1',
  ]);

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: 'teardown: zpool destroy failed: pool is busy\n',
  });
});

test('it fails the removal of a test container when told to', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubBootstrapDocker({ removal: 'fails' }),
  );

  const result = Bun.spawnSync([join(docker.bin, 'docker'), 'rm', '-f', '-v', 'imp-test-1']);

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: 'Error response from daemon: cannot remove container\n',
  });
});

test('it fails a call bootstrap.sh and its harness do not make as unexpected', () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.directoryPath, 'docker', buildStubBootstrapDocker({}));
  const result = Bun.spawnSync([join(docker.bin, 'docker'), 'ps']);

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: 'unexpected: docker ps\n',
  });
});
