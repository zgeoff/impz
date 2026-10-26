import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubDevHostDocker } from './build-stub-dev-host-docker';
import { createStubBin } from './create-stub-bin';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-dev-host-docker-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
}

test('it finds the host image when it has one', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({ containers: {}, hasImage: true }),
  );

  const result = Bun.spawnSync(['docker', 'image', 'inspect', 'imp-host:dev'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(result.exitCode).toBe(0);
});

test('it fails the inspect of the host image when it has none', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({ containers: {}, hasImage: false }),
  );

  const result = Bun.spawnSync(['docker', 'image', 'inspect', 'imp-host:dev'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(result.exitCode).toBe(1);
});

test('it finds the host image through podman image exists when it has one', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubDevHostDocker({ containers: {}, hasImage: true }),
  );

  const result = Bun.spawnSync(['podman', 'image', 'exists', 'imp-host:dev'], {
    env: { PATH: `${podman.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(result.exitCode).toBe(0);
});

test('it fails podman image exists when it has no host image', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubDevHostDocker({ containers: {}, hasImage: false }),
  );

  const result = Bun.spawnSync(['podman', 'image', 'exists', 'imp-host:dev'], {
    env: { PATH: `${podman.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(result.exitCode).toBe(1);
});

test("it prints the host image's id", () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({ containers: {}, hasImage: true }),
  );

  const result = Bun.spawnSync(['docker', 'image', 'inspect', '-f', '{{.Id}}', 'imp-host:dev'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(result.stdout.toString()).toBe('sha256:stub-host-image\n');
});

test('it reports a running container as running', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({
      containers: { 'imp-dev': true, 'imp-side': false },
      hasImage: true,
    }),
  );

  const result = Bun.spawnSync(['docker', 'inspect', '-f', '{{.State.Running}}', 'imp-dev'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(result.stdout.toString()).toBe('true\n');
});

test('it reports a stopped container as not running', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({
      containers: { 'imp-dev': true, 'imp-side': false },
      hasImage: true,
    }),
  );

  const result = Bun.spawnSync(['docker', 'inspect', '-f', '{{.State.Running}}', 'imp-side'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(result.stdout.toString()).toBe('false\n');
});

test('it fails the inspect of a container it does not know, as no such object', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({ containers: { 'imp-dev': true }, hasImage: true }),
  );

  const result = Bun.spawnSync(['docker', 'inspect', '-f', '{{.State.Running}}', 'imp-other'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({ exitCode: 1, stdout: '', stderr: 'Error: No such object\n' });
});

test("it starts a detached container and prints the container's id", () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({ containers: {}, hasImage: true }),
  );

  const result = Bun.spawnSync(['docker', 'run', '-d', '--name', 'imp-dev', 'imp-host:dev'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: 'c0ffee\n',
  });
});

test('it stops a container', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({ containers: { 'imp-dev': true }, hasImage: true }),
  );

  const result = Bun.spawnSync(['docker', 'stop', '-t', '120', 'imp-dev'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(result.exitCode).toBe(0);
});

test('it removes a container', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({ containers: {}, hasImage: true }),
  );

  const result = Bun.spawnSync(['docker', 'rm', '-f', 'imp-dev'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(result.exitCode).toBe(0);
});

test("it prints a container's log", () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({
      containers: {},
      hasImage: true,
      logs: { 'imp-dev': "impd: can't open /dev/kvm\n", 'imp-side': 'impd: up\n' },
    }),
  );

  const result = Bun.spawnSync(['docker', 'logs', '--tail', '40', 'imp-dev'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(result.stdout.toString()).toBe("impd: can't open /dev/kvm\n");
});

test('it prints no log for a container without one', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({ containers: {}, hasImage: true }),
  );

  const result = Bun.spawnSync(['docker', 'logs', '--tail', '40', 'imp-dev'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: '',
  });
});

test("it prints impd's pids for pgrep in the container", () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({
      containers: {},
      hasImage: true,
      impdPids: [4242, 4243],
    }),
  );

  const result = Bun.spawnSync(
    ['docker', 'exec', 'imp-dev', 'pgrep', '-f', 'bun .*/daemon/src/main.ts'],
    { env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: '4242\n4243\n',
  });
});

test('it fails pgrep with no output when impd has no pids', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({ containers: {}, hasImage: true }),
  );

  const result = Bun.spawnSync(
    ['docker', 'exec', 'imp-dev', 'pgrep', '-f', 'bun .*/daemon/src/main.ts'],
    { env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 1,
    stdout: '',
  });
});

test('it fails pgrep with the lookup error it is given', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({
      containers: {},
      hasImage: true,
      impdPids: [4242],
      impdLookupError: { exitCode: 127, stderr: 'exec: "pgrep": executable file not found\n' },
    }),
  );

  const result = Bun.spawnSync(
    ['docker', 'exec', 'imp-dev', 'pgrep', '-f', 'bun .*/daemon/src/main.ts'],
    { env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 127,
    stdout: '',
    stderr: 'exec: "pgrep": executable file not found\n',
  });
});

test('it builds an image quietly and prints its id', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({ containers: {}, hasImage: false }),
  );

  const result = Bun.spawnSync(
    ['docker', 'build', '-q', '-t', 'imp-host:dev', '-f', '/w/imp/host/Dockerfile', '/w/imp'],
    { env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: 'sha256:stub-built-image\n',
  });
});

test('it takes the SIGHUP to impd', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({ containers: {}, hasImage: true, impdPids: [4242] }),
  );

  const result = Bun.spawnSync(['docker', 'exec', 'imp-dev', 'kill', '-HUP', '4242'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(result.exitCode).toBe(0);
});

test('it fails kill -0 of impd once impd has exited, by default', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({ containers: {}, hasImage: true, impdPids: [4242] }),
  );

  const result = Bun.spawnSync(['docker', 'exec', 'imp-dev', 'kill', '-0', '4242'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(result.exitCode).toBe(1);
});

test('it passes kill -0 of an impd that does not exit', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({
      containers: {},
      hasImage: true,
      impdPids: [4242],
      impdExits: false,
    }),
  );

  const result = Bun.spawnSync(['docker', 'exec', 'imp-dev', 'kill', '-0', '4242'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(result.exitCode).toBe(0);
});

test('it fails a call that up and restart do not make, naming it', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({ containers: {}, hasImage: true }),
  );

  const result = Bun.spawnSync(['docker', 'volume', 'rm', 'imp-dev-data'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: 'stub docker: unexpected call: volume rm imp-dev-data\n',
  });
});

test('it names the binary it stands in for in an unexpected call', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubDevHostDocker({ containers: {}, hasImage: true }),
  );

  const result = Bun.spawnSync(['podman', 'volume', 'rm', 'imp-dev-data'], {
    env: { PATH: `${podman.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(result.stderr.toString()).toBe('stub podman: unexpected call: volume rm imp-dev-data\n');
});
