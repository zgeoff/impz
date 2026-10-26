import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubHostDocker } from './build-stub-host-docker';
import { createStubBin } from './create-stub-bin';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-host-docker-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return {
    directoryPath: directory,
  };
}

test('it answers that Docker runs imp-host, on an image id with sha256: before it', () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.directoryPath, 'docker', buildStubHostDocker({}));

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      'docker container inspect imp-host; echo "inspect $?"; docker inspect -f {{.Image}} imp-host',
    ],
    { env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect(result.stdout.toString()).toBe('inspect 0\nsha256:old\n');
});

test('it lists the awake imps as running, and sleeps each but the sleepless one', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubHostDocker({ awakeImps: ['web', 'db'], sleeplessImp: 'db' }),
  );

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      'docker exec imp-host impz ls --json; docker exec imp-host impz sleep web; echo "web $?"; ' +
        'docker exec imp-host impz sleep db; echo "db $?"',
    ],
    { env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect(result.stdout.toString()).toBe(
    '[{"name":"web","state":"running"},{"name":"db","state":"running"}]\nweb 0\ndb 1\n',
  );
});

test('it fails impz --version, as an image from before the CLI was impz does, and answers imp', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubHostDocker({ runningCLI: 'imp' }),
  );

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      'docker exec imp-host impz --version; echo "version $?"; docker exec imp-host imp ls --json',
    ],
    { env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect(result.stdout.toString()).toBe('version 126\n[]\n');
});

test('it removes the imp-host container', () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.directoryPath, 'docker', buildStubHostDocker({}));

  const result = Bun.spawnSync(['docker', 'rm', '-f', 'imp-host'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: 'imp-host\n',
  });
});

test('it lists the containers on its imp-host network, and removes it', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubHostDocker({ hostNetwork: ['imp-host', 'sidecar'] }),
  );

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      "docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' imp-host; " +
        'docker network rm imp-host; echo "rm $?"',
    ],
    { env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect(result.stdout.toString()).toBe('imp-host sidecar \nimp-host\nrm 0\n');
});

test('it lists the containers on an imp-host network in use, and fails to remove it', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubHostDocker({ hostNetwork: ['imp-host'], networkInUse: true }),
  );

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      "docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' imp-host; " +
        'docker network rm imp-host; echo "rm $?"',
    ],
    { env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect({ stdout: result.stdout.toString(), stderr: result.stderr.toString() }).toStrictEqual({
    stdout: 'imp-host \nrm 1\n',
    stderr:
      'Error response from daemon: error while removing network: network imp-host has active endpoints\n',
  });
});

test('it fails to inspect or remove an imp-host network it was given none of', () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.directoryPath, 'docker', buildStubHostDocker({}));

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      'docker network inspect -f \'{{.Name}}\' imp-host; echo "inspect $?"; ' +
        'docker network rm imp-host; echo "rm $?"',
    ],
    { env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect({ stdout: result.stdout.toString(), stderr: result.stderr.toString() }).toStrictEqual({
    stdout: 'inspect 1\nrm 1\n',
    stderr: 'Error: No such network: imp-host\n',
  });
});

test('it fails a call that upgrade.sh does not make', () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.directoryPath, 'docker', buildStubHostDocker({}));

  const result = Bun.spawnSync(['docker', 'pull', '-q', 'imp-host:next'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: 'unexpected: docker pull -q imp-host:next\n',
  });
});
