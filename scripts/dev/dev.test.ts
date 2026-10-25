import { expect, mock, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDevImageTag } from '../lib/build-dev-image-tag.ts';
import { buildStubDevDocker } from '../test-utils/build-stub-dev-docker';
import { buildStubDevHostDocker } from '../test-utils/build-stub-dev-host-docker';
import { createStubBin } from '../test-utils/create-stub-bin';
import { runDev } from './dev.ts';
import { wireDevIO } from './wire-dev-io.ts';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-dev-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return {
    directoryPath: directory,
  };
}

test('it refuses IMP_DEV_PUBLISH=0 without IMP_DEV_IP before it asks docker anything', () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.directoryPath, 'docker', 'exit 1');

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'token'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`, IMP_DEV_PUBLISH: '0' },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'dev.sh: IMP_DEV_PUBLISH=0 needs IMP_DEV_IP\n',
  });

  expect(readFileSync(docker.calls, 'utf8')).toBe('');
});

test('it refuses an unknown command with its usage and exit 2', () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.directoryPath, 'docker', 'exit 1');

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'start'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 2,
    stdout: '',
    stderr: 'usage: scripts/dev/dev.sh up|down|reboot|logs|restart|shell|token|prune\n',
  });
});

test('it refuses a restart when the container is not running', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({ containers: {}, hasImage: true }),
  );

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'restart'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`, IMP_DEV_DATA: ctx.directoryPath },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'dev.sh: imp-dev is not running; use scripts/dev/dev.sh up\n',
  });
});

test("it removes an older checkout's docker proxy container and both its volumes on down, and finishes when none exist", () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({ containers: { 'imp-dev': false }, hasImage: true }),
  );

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'down'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`, IMP_DEV_DATA: ctx.directoryPath },
  });

  expect(result.exitCode).toBe(0);

  expect(readFileSync(docker.calls, 'utf8')).toBe(
    [
      'docker inspect -f {{.State.Running}} imp-dev',
      'docker rm -f imp-dev imp-dev-docker-proxy',
      'docker volume rm imp-dev-docker imp-dev-docker-proxy',
      '',
    ].join('\n'),
  );
});

test.each([
  ['reports impd is not ready', `echo '{"ready":false}'`],
  ['exits nonzero after it printed ready', `echo '{"ready":true'; exit 18`],
])('it fails a restart by IMP_DEV_READY_TIMEOUT_S whose health check %s', (_label, curl) => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({
      containers: { 'imp-dev': true },
      hasImage: true,
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', curl);

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'restart'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_DEV_DATA: join(ctx.directoryPath, 'data'),
      IMP_HOST_IMAGE: 'imp-host:dev-test',
      IMP_DEV_READY_TIMEOUT_S: '1',
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'dev.sh: impd not ready after 1s\n',
  });
});

test('it finishes a restart under IMP_DEV_READY_TIMEOUT_S once impd reports ready', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({
      containers: { 'imp-dev': true },
      hasImage: true,
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'restart'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_DEV_DATA: join(ctx.directoryPath, 'data'),
      IMP_HOST_IMAGE: 'imp-host:dev-test',
      IMP_DEV_READY_TIMEOUT_S: '1',
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
});

test('it fails a restart whose old impd does not exit by IMP_DEV_STOP_TIMEOUT_S', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({
      containers: { 'imp-dev': true },
      hasImage: true,
      impdPids: [4242],
      impdExits: false,
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'restart'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_DEV_DATA: join(ctx.directoryPath, 'data'),
      IMP_HOST_IMAGE: 'imp-host:dev-test',
      IMP_DEV_STOP_TIMEOUT_S: '1',
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'dev.sh: impd 4242 did not exit\n',
  });
});

test('it finishes a restart under IMP_DEV_STOP_TIMEOUT_S once the old impd exits', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({
      containers: { 'imp-dev': true },
      hasImage: true,
      impdPids: [4242],
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'restart'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_DEV_DATA: join(ctx.directoryPath, 'data'),
      IMP_HOST_IMAGE: 'imp-host:dev-test',
      IMP_DEV_STOP_TIMEOUT_S: '1',
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });

  expect(readFileSync(docker.calls, 'utf8')).toInclude('docker exec imp-dev kill -HUP 4242\n');
});

test('it fails a restart whose IMP_DEV_READY_TIMEOUT_S is not a number', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({
      containers: { 'imp-dev': true },
      hasImage: true,
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":false}'`);

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'restart'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_DEV_DATA: join(ctx.directoryPath, 'data'),
      IMP_HOST_IMAGE: 'imp-host:dev-test',
      IMP_DEV_READY_TIMEOUT_S: 'oops',
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'dev.sh: IMP_DEV_READY_TIMEOUT_S=oops is not a number of seconds\n',
  });
});

test('it fails a restart with the reason when it cannot look up the old impd', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({
      containers: { 'imp-dev': true },
      hasImage: true,
      impdLookupError: { exitCode: 127, stderr: 'exec: "pgrep": executable file not found\n' },
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'restart'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_DEV_DATA: join(ctx.directoryPath, 'data'),
      IMP_HOST_IMAGE: 'imp-host:dev-test',
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: `dev.sh: cannot find impd's process in imp-dev\nexec: "pgrep": executable file not found\n`,
  });

  expect(readFileSync(docker.calls, 'utf8')).not.toInclude('kill -HUP');
});

test('it refuses up when IMP_KERNEL names a directory', () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.directoryPath, 'docker', 'exit 1');

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'up'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_DEV_DATA: join(ctx.directoryPath, 'data'),
      IMP_KERNEL: ctx.directoryPath,
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: `dev.sh: no kernel at ${ctx.directoryPath}\n`,
  });

  expect(readFileSync(docker.calls, 'utf8')).toBe('');
});

test('it refuses up when IMP_SYSTEM_DRIVE names a directory', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({ containers: {}, hasImage: true }),
  );

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'up'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_DEV_DATA: join(ctx.directoryPath, 'data'),

      IMP_KERNEL: new URL('../../package.json', import.meta.url).pathname,
      IMP_SYSTEM_DRIVE: ctx.directoryPath,
      IMP_HOST_IMAGE: 'imp-host:dev-test',
      IMP_HOST_IMAGE_READY: '1',
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: `dev.sh: no system drive at ${ctx.directoryPath}\n`,
  });
});

test('it refuses up without a kernel before it asks docker anything', () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.directoryPath, 'docker', 'exit 1');

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'up'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_DEV_DATA: join(ctx.directoryPath, 'data'),
      IMP_KERNEL: join(ctx.directoryPath, 'vmlinux'),
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: `dev.sh: no kernel at ${join(ctx.directoryPath, 'vmlinux')}\n`,
  });

  expect(readFileSync(docker.calls, 'utf8')).toBe('');
});

test('it refuses up with IMP_HOST_IMAGE_READY=1 when there is no host image', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({ containers: {}, hasImage: false }),
  );

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'up'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_DEV_DATA: join(ctx.directoryPath, 'data'),

      IMP_KERNEL: new URL('../../package.json', import.meta.url).pathname,
      IMP_SYSTEM_DRIVE: new URL('../../package.json', import.meta.url).pathname,
      IMP_HOST_IMAGE: 'imp-host:dev-test',
      IMP_HOST_IMAGE_READY: '1',
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'dev.sh: IMP_HOST_IMAGE_READY=1 but there is no imp-host:dev-test image\n',
  });
});

test('it refuses up without the system drive IMP_SYSTEM_DRIVE names', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({ containers: {}, hasImage: true }),
  );

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'up'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_DEV_DATA: join(ctx.directoryPath, 'data'),

      IMP_KERNEL: new URL('../../package.json', import.meta.url).pathname,
      IMP_SYSTEM_DRIVE: join(ctx.directoryPath, 'imp-system.squashfs'),
      IMP_HOST_IMAGE: 'imp-host:dev-test',
      IMP_HOST_IMAGE_READY: '1',
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: `dev.sh: no system drive at ${join(ctx.directoryPath, 'imp-system.squashfs')}\n`,
  });
});

test('it refuses up with IMP_TAILNET_NAMES=1 when 1Password has no OAuth client', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({
      containers: {},
      hasImage: true,
    }),
  );

  createStubBin(ctx.directoryPath, 'op', 'exit 1');

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'up'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_DEV_DATA: join(ctx.directoryPath, 'data'),

      IMP_KERNEL: new URL('../../package.json', import.meta.url).pathname,
      IMP_SYSTEM_DRIVE: new URL('../../package.json', import.meta.url).pathname,
      IMP_HOST_IMAGE: 'imp-host:dev-test',
      IMP_HOST_IMAGE_READY: '1',
      IMP_DEV_TAILNET: '0',
      IMP_TAILNET_NAMES: '1',
      IMP_OP_VAULT: 'example',
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'dev.sh: IMP_TAILNET_NAMES=1 but 1Password has no OAuth client\n',
  });

  expect(readFileSync(docker.calls, 'utf8')).not.toInclude('docker run -d --name imp-dev ');
});

test('it passes the Tailscale key to docker in its environment, never in its arguments', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    [
      `case "$*" in "run -d --name imp-dev-trace-check "*) printf '%s' "$TAILSCALE_AUTHKEY" > '${join(ctx.directoryPath, 'docker-env-key')}'; exit 1 ;; esac`,
      'case "$1" in run|inspect) exit 1 ;; esac',
      'exit 0',
    ].join('\n'),
  );

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'up'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      HOME: ctx.directoryPath,
      TAILSCALE_AUTHKEY: 'fake-tskey-for-the-trace-check',
      IMP_TAILSCALE_TAGS: 'tag:imp-e2e',
      IMP_DEV_NAME: 'imp-dev-trace-check',
      IMP_DEV_DATA: join(ctx.directoryPath, 'data'),
      IMP_HOST_IMAGE_READY: '1',

      IMP_KERNEL: new URL('../../package.json', import.meta.url).pathname,
      IMP_SYSTEM_DRIVE: new URL('../../package.json', import.meta.url).pathname,
    },
  });

  const calls = readFileSync(docker.calls, 'utf8');

  expect(result.exitCode).toBe(1);
  expect(calls).toContain('-e TAILSCALE_AUTHKEY ');
  expect(calls).toContain('-e IMP_TAILSCALE_TAGS=tag:imp-e2e');
  expect(calls).not.toContain('fake-tskey-for-the-trace-check');
  expect(result.stderr.toString()).not.toContain('fake-tskey-for-the-trace-check');

  expect(readFileSync(join(ctx.directoryPath, 'docker-env-key'), 'utf8')).toBe(
    'fake-tskey-for-the-trace-check',
  );
});

test('it refuses up with an IMP_ACME_CA_FILE outside the repo', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({
      containers: {},
      hasImage: true,
    }),
  );

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'up'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_DEV_DATA: join(ctx.directoryPath, 'data'),

      IMP_KERNEL: new URL('../../package.json', import.meta.url).pathname,
      IMP_SYSTEM_DRIVE: new URL('../../package.json', import.meta.url).pathname,
      IMP_HOST_IMAGE: 'imp-host:dev-test',
      IMP_HOST_IMAGE_READY: '1',
      IMP_DEV_TAILNET: '0',
      IMP_ACME_CA_FILE: join(ctx.directoryPath, 'pebble-ca.pem'),
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: `dev.sh: ${join(ctx.directoryPath, 'pebble-ca.pem')} is not under ${new URL('../..', import.meta.url).pathname.replace(/\/$/u, '')}\n`,
  });

  expect(readFileSync(docker.calls, 'utf8')).not.toInclude('docker run -d --name imp-dev ');
});

test("it passes the test registry to impd, at this machine's address for its name, and maps its CA into the container", () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({
      containers: { 'imp-dev': false },
      hasImage: true,
      logs: { 'imp-dev': 'impd: /dev/kvm is missing\n' },
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', 'exit 7');
  createStubBin(ctx.directoryPath, 'getent', 'echo "10.200.0.1      STREAM registry.example.test"');

  Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'up'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_DEV_DATA: join(ctx.directoryPath, 'data'),

      IMP_KERNEL: new URL('../../package.json', import.meta.url).pathname,
      IMP_SYSTEM_DRIVE: new URL('../../package.json', import.meta.url).pathname,
      IMP_HOST_IMAGE: 'imp-host:dev-test',
      IMP_HOST_IMAGE_READY: '1',
      IMP_DEV_TAILNET: '0',
      IMP_UPLINK_MTU: '1500',
      IMP_E2E: '1',
      IMP_BUILD_TEST_REGISTRY: 'registry.example.test:5443',
      IMP_BUILD_TEST_REGISTRY_CA: new URL('../../.cache/e2e/registry-ca.pem', import.meta.url)
        .pathname,
    },
  });

  const run = readFileSync(docker.calls, 'utf8')
    .split('\n')
    .find((line) => line.startsWith('docker run -d --name imp-dev '));

  expect(run).toInclude(' -e IMP_BUILD_TEST_REGISTRY=registry.example.test:5443 ');
  expect(run).toInclude(' -e IMP_BUILD_TEST_REGISTRY_CA=/src/.cache/e2e/registry-ca.pem ');
  expect(run).toInclude(' --add-host registry.example.test:10.200.0.1 ');
});

test('it refuses up with a test registry whose name does not resolve on this machine', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({
      containers: {},
      hasImage: true,
    }),
  );

  createStubBin(ctx.directoryPath, 'getent', 'exit 2');

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'up'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_DEV_DATA: join(ctx.directoryPath, 'data'),

      IMP_KERNEL: new URL('../../package.json', import.meta.url).pathname,
      IMP_SYSTEM_DRIVE: new URL('../../package.json', import.meta.url).pathname,
      IMP_HOST_IMAGE: 'imp-host:dev-test',
      IMP_HOST_IMAGE_READY: '1',
      IMP_DEV_TAILNET: '0',
      IMP_UPLINK_MTU: '1500',
      IMP_E2E: '1',
      IMP_BUILD_TEST_REGISTRY: 'registry.example.test:5443',
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr:
      'dev.sh: registry.example.test (IMP_BUILD_TEST_REGISTRY) does not resolve on this machine\n',
  });

  expect(readFileSync(docker.calls, 'utf8')).not.toInclude('docker run -d --name imp-dev ');
});

test('it fails up when the container stops before impd is ready, printing its log', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({
      containers: { 'imp-dev': false },
      hasImage: true,
      logs: { 'imp-dev': 'impd: /dev/kvm is missing\n' },
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', 'exit 7');

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'up'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_DEV_DATA: join(ctx.directoryPath, 'data'),

      IMP_KERNEL: new URL('../../package.json', import.meta.url).pathname,
      IMP_SYSTEM_DRIVE: new URL('../../package.json', import.meta.url).pathname,
      IMP_HOST_IMAGE: 'imp-host:dev-test',
      IMP_HOST_IMAGE_READY: '1',
      IMP_DEV_TAILNET: '0',
      IMP_UPLINK_MTU: '1500',
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'dev.sh: started imp-dev\n',
    stderr: 'dev.sh: imp-dev stopped; last log lines:\nimpd: /dev/kvm is missing\n',
  });
});

test('it gives the container the real path of a kernel that a symlink outside the repo leads to', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevHostDocker({
      containers: { 'imp-dev': false },
      hasImage: true,
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', 'exit 7');

  const kernel = join(ctx.directoryPath, 'vmlinux');

  symlinkSync(new URL('../../package.json', import.meta.url).pathname, kernel);

  Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'up'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_DEV_DATA: join(ctx.directoryPath, 'data'),

      IMP_KERNEL: kernel,
      IMP_SYSTEM_DRIVE: new URL('../../package.json', import.meta.url).pathname,
      IMP_HOST_IMAGE: 'imp-host:dev-test',
      IMP_HOST_IMAGE_READY: '1',
      IMP_DEV_TAILNET: '0',
      IMP_UPLINK_MTU: '1500',
    },
  });

  expect(readFileSync(docker.calls, 'utf8')).toInclude(' -e IMP_KERNEL=/src/package.json ');
});

test('it runs logs, shell and token on the caller terminal through the given runner', async () => {
  const runAttached = mock(() => Promise.resolve(3));

  const exitCode = await runDev({
    argv: ['token'],
    env: {},
    cwd: '/',
    io: { ...wireDevIO(), runAttached },
  });

  expect(exitCode).toBe(3);

  expect(runAttached).toHaveBeenCalledExactlyOnceWith([
    'docker',
    'exec',
    'imp-dev',
    'cat',
    '/var/lib/imp/token',
  ]);
});

test('it stops before it asks docker anything when there is no machine id', () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.directoryPath, 'docker', 'exit 1');

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'prune'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_MACHINE_ID_FILE: join(ctx.directoryPath, 'no-machine-id'),
    },
  });

  expect(result.exitCode).toBe(1);

  expect(result.stderr.toString()).toBe(
    `dev.sh: prune needs a machine id in ${join(ctx.directoryPath, 'no-machine-id')}\n`,
  );

  expect(readFileSync(docker.calls, 'utf8')).toBe('');
});

test('it fails prune with the reason when docker cannot list the images', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directoryPath, 'machine-id'), 'fake-machine-id\n');

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    'echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" >&2; exit 1',
  );

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'prune'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_MACHINE_ID_FILE: join(ctx.directoryPath, 'machine-id'),
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr:
      'dev.sh: docker image ls failed\nCannot connect to the Docker daemon at unix:///var/run/docker.sock\n',
  });
});

test('it removes the own tag of a gone checkout on this machine, then the leftovers', () => {
  const ctx = setupTest();
  const tag = buildDevImageTag(join(ctx.directoryPath, 'gone'));

  writeFileSync(join(ctx.directoryPath, 'machine-id'), 'fake-machine-id\n');

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevDocker([
      {
        tag,
        id: 'id-gone',
        labels: { worktree: join(ctx.directoryPath, 'gone'), machine: 'fake-machine-id' },
      },
    ]),
  );

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'prune'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_MACHINE_ID_FILE: join(ctx.directoryPath, 'machine-id'),
    },
  });

  expect(result.exitCode).toBe(0);

  expect(result.stdout.toString()).toBe(
    `dev.sh: removed ${tag} (${join(ctx.directoryPath, 'gone')} is gone)\n`,
  );

  expect(
    readFileSync(docker.calls, 'utf8')
      .split('\n')
      .filter((call) => /^docker image (?:rm|prune) /u.test(call)),
  ).toStrictEqual([
    `docker image rm ${tag}`,
    'docker image prune -f --filter label=imp.worktree --filter label=imp.machine=fake-machine-id',
  ]);
});

test("it never removes a live checkout's image, another machine's, or an unmarked one", () => {
  const ctx = setupTest();
  const other = join(ctx.directoryPath, 'other');
  const unmarked = join(ctx.directoryPath, 'unmarked');

  writeFileSync(join(ctx.directoryPath, 'machine-id'), 'fake-machine-id\n');

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevDocker([
      {
        tag: buildDevImageTag(ctx.directoryPath),
        id: 'id-live',
        labels: { worktree: ctx.directoryPath, machine: 'fake-machine-id' },
      },
      {
        tag: buildDevImageTag(other),
        id: 'id-other',
        labels: { worktree: join(ctx.directoryPath, 'other'), machine: 'another-machine' },
      },
      {
        tag: buildDevImageTag(unmarked),
        id: 'id-unmarked',
        labels: { worktree: join(ctx.directoryPath, 'unmarked'), machine: '' },
      },
      {
        tag: 'imp-host:dev-empty-4',
        id: 'id-empty',
        labels: { worktree: '', machine: 'fake-machine-id' },
      },
      { tag: '<none>:<none>', id: 'id-dangling', labels: null },
    ]),
  );

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'prune'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_MACHINE_ID_FILE: join(ctx.directoryPath, 'machine-id'),
    },
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe('');

  expect(
    readFileSync(docker.calls, 'utf8')
      .split('\n')
      .filter((call) => call.startsWith('docker image rm ')),
  ).toStrictEqual([]);
});

test('it keeps a gone checkout image it cannot remove, and says why', () => {
  const ctx = setupTest();
  const stuck = buildDevImageTag(join(ctx.directoryPath, 'stuck'));
  const used = buildDevImageTag(join(ctx.directoryPath, 'used'));

  writeFileSync(join(ctx.directoryPath, 'machine-id'), 'fake-machine-id\n');

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubDevDocker([
      {
        tag: stuck,
        id: 'id-stuck',
        labels: { worktree: join(ctx.directoryPath, 'stuck'), machine: 'fake-machine-id' },
        isStuck: true,
      },
      {
        tag: 'imp-host:pinned',
        id: 'id-pinned',
        labels: { worktree: join(ctx.directoryPath, 'stuck'), machine: 'fake-machine-id' },
      },
      {
        tag: used,
        id: 'id-used',
        labels: { worktree: join(ctx.directoryPath, 'used'), machine: 'fake-machine-id' },
        container: 'c0ffee',
      },
      { tag: 'imp-host:dev-broken-5', id: 'id-broken', labels: null },
    ]),
  );

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'prune'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_MACHINE_ID_FILE: join(ctx.directoryPath, 'machine-id'),
    },
  });

  expect(result.exitCode).toBe(0);

  expect(result.stdout.toString().split('\n')).toStrictEqual([
    `dev.sh: keeping ${stuck}: docker image rm failed`,
    `dev.sh: keeping imp-host:pinned: not the tag of ${join(ctx.directoryPath, 'stuck')}`,
    `dev.sh: keeping ${used}: a container uses it`,
    'dev.sh: keeping imp-host:dev-broken-5: docker image inspect failed',
    '',
  ]);
});
