import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubBin } from '@impz/test-utils/create-stub-bin';
import { buildStubHostPodman } from './build-stub-host-podman';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-host-podman-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return {
    directoryPath: directory,
  };
}

test('it answers the image ids, without sha256:, and the contract label of the pulled image', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'unit',
    }),
  );

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      'podman inspect -f {{.Image}} imp-host; podman image inspect -f {{.Id}} imp-host:next; ' +
        'podman image inspect -f x imp-host:next',
    ],
    { env: { PATH: `${podman.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect(result.stdout.toString()).toBe('old\nnew\nno-docker\n');
});

test.each([
  ['host', 'podman inspect -f {{.Image}} imp-host'],
  ['pulled', 'podman image inspect -f {{.Id}} imp-host:next'],
] as const)('it fails the %s image inspect when told to', (failedInspect, command) => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'unit',
      failedInspect,
    }),
  );

  const result = Bun.spawnSync(['bash', '-c', command], {
    env: { PATH: `${podman.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({ exitCode: 125, stdout: '', stderr: 'Error: no such object\n' });
});

test('it answers the running image id for the pulled image when that runs already', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'unit',
      pulledIsRunning: true,
    }),
  );

  const result = Bun.spawnSync(['podman', 'image', 'inspect', '-f', '{{.Id}}', 'imp-host:next'], {
    env: { PATH: `${podman.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(result.stdout.toString()).toBe('old\n');
});

test('it says imp-host exists unless told Podman does not run it', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'unit',
    }),
  );

  const result = Bun.spawnSync(['podman', 'container', 'exists', 'imp-host'], {
    env: { PATH: `${podman.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(result.exitCode).toBe(0);
});

test('it says imp-host does not exist when Podman does not run it', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'unit',
      runsHost: false,
    }),
  );

  const result = Bun.spawnSync(['podman', 'container', 'exists', 'imp-host'], {
    env: { PATH: `${podman.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(result.exitCode).toBe(1);
});

test("it prints the pulled image's unit and an empty seccomp profile", () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: "ExecStart=/usr/bin/podman run 'quoted' imp-host\n",
    }),
  );

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      'podman run --rm imp-host:next cat /deploy/imp-host.service; ' +
        'podman run --rm imp-host:next cat /deploy/imp-host.seccomp.json',
    ],
    { env: { PATH: `${podman.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect(result.stdout.toString()).toBe("ExecStart=/usr/bin/podman run 'quoted' imp-host\n{}\n");
});

test('it fails to print the deploy file it is told cannot be read', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'unit',
      unreadableFile: '.service',
    }),
  );

  const result = Bun.spawnSync(
    ['podman', 'run', '--rm', 'imp-host:next', 'cat', '/deploy/imp-host.service'],
    { env: { PATH: `${podman.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 1,
    stdout: '',
  });
});

test('it fails a call that upgrade.sh does not make', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'unit',
    }),
  );

  const result = Bun.spawnSync(['podman', 'system', 'prune'], {
    env: { PATH: `${podman.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: 'unexpected: podman system prune\n',
  });
});

test('it lists the awake imps as running, and sleeps each but the sleepless one', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'unit',
      awakeImps: ['web', 'db'],
      sleeplessImp: 'db',
    }),
  );

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      'podman exec imp-host impz ls --json; podman exec imp-host impz sleep web; echo "web $?"; ' +
        'podman exec imp-host impz sleep db; echo "db $?"',
    ],
    { env: { PATH: `${podman.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect(result.stdout.toString()).toBe(
    '[{"name":"web","state":"running"},{"name":"db","state":"running"}]\nweb 0\ndb 1\n',
  );
});

test('it lists no imps when none are awake', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'unit',
    }),
  );

  const result = Bun.spawnSync(['podman', 'exec', 'imp-host', 'impz', 'ls', '--json'], {
    env: { PATH: `${podman.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(result.stdout.toString()).toBe('[]\n');
});

test('it fails impz --version, as an image from before the CLI was impz does, and answers imp', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'unit',
      runningCLI: 'imp',
    }),
  );

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      'podman exec imp-host impz --version; echo "version $?"; podman exec imp-host imp ls --json',
    ],
    { env: { PATH: `${podman.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect(result.stdout.toString()).toBe('version 126\n[]\n');
});

test('it answers pull and plain impz ls with success and no output', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'unit',
    }),
  );

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      'podman pull -q imp-host:next; echo "pull $?"; podman exec imp-host impz ls; echo "ls $?"',
    ],
    { env: { PATH: `${podman.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect({ stdout: result.stdout.toString(), stderr: result.stderr.toString() }).toStrictEqual({
    stdout: 'pull 0\nls 0\n',
    stderr: '',
  });
});

test('it fails a pull of another image than the one it was given', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'unit',
    }),
  );

  const result = Bun.spawnSync(['podman', 'pull', '-q', 'imp-host:other'], {
    env: { PATH: `${podman.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(result.exitCode).toBe(1);
});

test('it answers impz info with an empty object unless told otherwise', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'unit',
    }),
  );

  const result = Bun.spawnSync(['podman', 'exec', 'imp-host', 'impz', 'info', '--json'], {
    env: { PATH: `${podman.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(result.stdout.toString()).toBe('{}\n');
});

test('it answers impz info with what it was given', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'unit',
      impInfo: '{"bootStatus":null}',
    }),
  );

  const result = Bun.spawnSync(['podman', 'exec', 'imp-host', 'impz', 'info', '--json'], {
    env: { PATH: `${podman.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(result.stdout.toString()).toBe('{"bootStatus":null}\n');
});

test('it fails impz info when told to', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'unit',
      impInfo: null,
    }),
  );

  const result = Bun.spawnSync(['podman', 'exec', 'imp-host', 'impz', 'info', '--json'], {
    env: { PATH: `${podman.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 1,
    stdout: '',
  });
});
