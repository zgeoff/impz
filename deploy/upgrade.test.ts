import { expect, onTestFinished, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod';
import { buildStubHostDocker } from '../scripts/test-utils/build-stub-host-docker';
import { buildStubHostPodman } from '../scripts/test-utils/build-stub-host-podman';
import { buildStubUnitSystemctl } from '../scripts/test-utils/build-stub-unit-systemctl';
import { createStubBin } from '../scripts/test-utils/create-stub-bin';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-upgrade-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  // upgrade.sh restarts the units through systemctl
  createStubBin(directory, 'systemctl');

  return {
    directoryPath: directory,
  };
}

test('it installs the unit and restarts imp-host, and tells how to roll back, on a Podman host', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'ghcr.io/zgeoff/imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'ExecStart=/usr/bin/podman run --name imp-host imp-host\n',
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    'ExecStart=/usr/bin/podman run --cap-drop ALL imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  const calls = readFileSync(podman.calls, 'utf8');

  expect(result.exitCode).toBe(0);

  expect(readFileSync(join(ctx.directoryPath, 'imp-host.service'), 'utf8')).toBe(
    'ExecStart=/usr/bin/podman run --name imp-host imp-host\n',
  );

  expect(readFileSync(join(ctx.directoryPath, 'imp-host.seccomp.json'), 'utf8')).toBe('{}\n');
  expect(calls).toInclude('systemctl daemon-reload\nsystemctl restart imp-host\n');
  expect(calls).not.toInclude('docker');

  expect(result.stdout.toString()).toInclude(
    'upgrade: done. To roll back: podman tag old ghcr.io/zgeoff/imp-host:next, then systemctl restart imp-host.\n',
  );
});

test('it keeps the unit it replaces as a .bak, and names it', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'ghcr.io/zgeoff/imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'ExecStart=/usr/bin/podman run --name imp-host imp-host\n',
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    'ExecStart=/usr/bin/podman run --cap-drop ALL imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  const backups = readdirSync(ctx.directoryPath).filter((file) =>
    /^imp-host\.service\.bak-\d{8}-\d{6}$/v.test(file),
  );

  expect(result.exitCode).toBe(0);

  expect(backups.map((file) => readFileSync(join(ctx.directoryPath, file), 'utf8'))).toStrictEqual([
    'ExecStart=/usr/bin/podman run --cap-drop ALL imp-host\n',
  ]);

  expect(result.stdout.toString()).toInclude(
    `upgrade: installed ${join(ctx.directoryPath, 'imp-host.service')} from ghcr.io/zgeoff/imp-host:next (the unit before: ${join(ctx.directoryPath, backups.join(''))})\n`,
  );
});

test('it keeps no .bak and reloads no units when the unit is unchanged', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'ghcr.io/zgeoff/imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'ExecStart=/usr/bin/podman run --name imp-host imp-host\n',
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    'ExecStart=/usr/bin/podman run --name imp-host imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  const calls = readFileSync(podman.calls, 'utf8');

  expect(result.exitCode).toBe(0);
  expect(readdirSync(ctx.directoryPath).filter((file) => file.includes('.bak-'))).toBeEmpty();
  expect(calls).not.toInclude('daemon-reload');
  expect(calls).toInclude('systemctl restart imp-host\n');
});

test.each([
  ['socket-proxy', 'socket-proxy'],
  ['unprivileged', 'unprivileged'],
  ['no label', ''],
])(
  'it refuses an image with %s for its host contract, which needs a Docker socket, before anything changes',
  (_, label) => {
    const ctx = setupTest();

    const podman = createStubBin(
      ctx.directoryPath,
      'podman',
      buildStubHostPodman({
        image: 'ghcr.io/zgeoff/imp-host:old',
        pulledLabel: label,
        pulledUnit: 'ExecStart=/usr/bin/docker run --cap-drop ALL imp-host\n',
        awakeImps: ['web'],
      }),
    );

    createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

    writeFileSync(
      join(ctx.directoryPath, 'imp-host.service'),
      'ExecStart=/usr/bin/podman run --name imp-host imp-host\n',
    );

    const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
      env: {
        PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
        IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:old',
        IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
        IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
        IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
        IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
      },
    });

    const calls = readFileSync(podman.calls, 'utf8');

    expect(result.exitCode).toBe(1);

    expect(result.stderr.toString()).toInclude(
      'upgrade: ghcr.io/zgeoff/imp-host:old needs a Docker socket',
    );

    expect(result.stderr.toString()).toInclude(
      'put back the imp-host.service.bak-<time> (and imp-docker-proxy.service.bak-<time>) units',
    );

    expect(readFileSync(join(ctx.directoryPath, 'imp-host.service'), 'utf8')).toBe(
      'ExecStart=/usr/bin/podman run --name imp-host imp-host\n',
    );

    expect(existsSync(join(ctx.directoryPath, 'imp-host.seccomp.json'))).toBeFalse();
    expect(calls).not.toInclude('systemctl');
    expect(calls).not.toInclude('impz');
  },
);

test('it refuses --compose, saying the systemd unit replaces the Compose recipe', () => {
  const ctx = setupTest();
  const podman = createStubBin(ctx.directoryPath, 'podman');

  const result = Bun.spawnSync(
    ['bash', new URL('upgrade.sh', import.meta.url).pathname, '--compose', 'compose.yaml'],
    {
      env: {
        PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
        IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
        IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
        IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
        IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
      },
    },
  );

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr:
      'upgrade: the Compose recipe is gone; the systemd unit that deploy/bootstrap.sh installs replaces it (docs/guides/install.md). Nothing changed.\n',
  });

  expect(readFileSync(podman.calls, 'utf8')).toBe('');
});

test('it refuses any argument with its usage', () => {
  const ctx = setupTest();

  const result = Bun.spawnSync(
    ['bash', new URL('upgrade.sh', import.meta.url).pathname, '--check'],
    {
      env: {
        PATH: `${join(ctx.directoryPath, 'bin')}:${process.env['PATH'] ?? ''}`,
        IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
        IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
        IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
        IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
      },
    },
  );

  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toStartWith('usage: ');
  expect(result.stderr.toString()).toEndWith('upgrade.sh\n');
});

test('it refuses to run on a host without podman, saying how to install it', () => {
  const ctx = setupTest();
  const curl = createStubBin(ctx.directoryPath, 'curl');

  createStubBin(ctx.directoryPath, 'jq');

  const result = Bun.spawnSync(
    [Bun.which('bash') ?? 'bash', new URL('upgrade.sh', import.meta.url).pathname],
    {
      env: {
        PATH: curl.bin,
        IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
        IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
        IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
        IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
      },
    },
  );

  expect(result.exitCode).toBe(1);

  expect(result.stderr.toString()).toBe(
    "upgrade: podman is not installed; install it (apt-get install podman catatonit netavark aardvark-dns iptables), or run this release's deploy/bootstrap.sh\n",
  );

  expect(readFileSync(curl.calls, 'utf8')).toBe('');
});

test('it refuses to run on a host without jq', () => {
  const ctx = setupTest();
  const podman = createStubBin(ctx.directoryPath, 'podman');

  createStubBin(ctx.directoryPath, 'curl');

  const result = Bun.spawnSync(
    [Bun.which('bash') ?? 'bash', new URL('upgrade.sh', import.meta.url).pathname],
    {
      env: {
        PATH: podman.bin,
        IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
        IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
        IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
        IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
      },
    },
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toBe('upgrade: jq is not installed\n');
  expect(readFileSync(podman.calls, 'utf8')).toBe('');
});

// the command of the releases before deploy/lib/host-env.sh took upgrade.sh alone
test('it refuses to run without lib/host-env.sh beside it, saying how to take both from the image', () => {
  const ctx = setupTest();
  const podman = createStubBin(ctx.directoryPath, 'podman');

  writeFileSync(
    join(ctx.directoryPath, 'upgrade.sh'),
    readFileSync(new URL('upgrade.sh', import.meta.url), 'utf8'),
  );

  const result = Bun.spawnSync(['bash', 'upgrade.sh'], {
    cwd: ctx.directoryPath,
    env: { PATH: `${podman.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(result.exitCode).toBe(1);

  expect(result.stderr.toString()).toBe(
    'upgrade: no ./lib/host-env.sh beside this script; take both from the new image: ' +
      'podman run --rm <new image> tar -cf - -C /usr/local/share/imp deploy | tar -xf -, ' +
      'then run deploy/upgrade.sh (docs/guides/operations.md#upgrade)\n',
  );

  expect(readFileSync(podman.calls, 'utf8')).toBe('');
});

test('it refuses a host with no imp-host container under Podman or Docker, before any pull', () => {
  const ctx = setupTest();
  const podman = createStubBin(ctx.directoryPath, 'podman', 'exit 1');

  createStubBin(ctx.directoryPath, 'docker', 'exit 1');

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  expect(result.exitCode).toBe(1);

  expect(result.stderr.toString()).toBe(
    'upgrade: no imp-host container; start the host first (docs/guides/install.md)\n',
  );

  expect(readFileSync(podman.calls, 'utf8')).toBe(
    'podman container exists imp-host\ndocker container inspect imp-host\n',
  );
});

test('it moves a Docker host with IPv6 and the proxy to Podman: stop on the old unit, then the container, the proxy and the network, then the new unit and a start', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'ghcr.io/zgeoff/imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'ExecStart=/usr/bin/podman run --name imp-host imp-host\n',
      runsHost: false,
    }),
  );

  createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubHostDocker({ awakeImps: ['web'], hostNetwork: ['imp-host'] }),
  );

  createStubBin(
    ctx.directoryPath,
    'systemctl',
    buildStubUnitSystemctl(join(ctx.directoryPath, 'imp-host.service')),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --name imp-host imp-host\n',
  );

  writeFileSync(
    join(ctx.directoryPath, 'imp-docker-proxy.service'),
    'ExecStart=/usr/bin/docker run --name imp-docker-proxy imp-host\n',
  );

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.env'),
    'IMP_HOST_NETWORK=--network imp-host\nIMP_HOST_SUBNET6=fd00:7a::/64\n',
    { mode: 0o600 },
  );

  mkdirSync(join(ctx.directoryPath, 'imp-data', 'imps'), { recursive: true });
  writeFileSync(join(ctx.directoryPath, 'imp-data', 'imps', 'web.img'), 'disk of web');

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  expect(result.exitCode).toBe(0);

  expect(readFileSync(podman.calls, 'utf8')).toBe(
    [
      'podman container exists imp-host',
      'docker container inspect imp-host',
      'podman pull -q ghcr.io/zgeoff/imp-host:next',
      'docker inspect -f {{.Image}} imp-host',
      'podman image inspect -f {{.Id}} ghcr.io/zgeoff/imp-host:next',
      'podman image inspect -f {{index .Config.Labels "imp.host-contract"}} ghcr.io/zgeoff/imp-host:next',
      'docker network inspect -f {{range .Containers}}{{.Name}} {{end}} imp-host',
      'podman run --rm ghcr.io/zgeoff/imp-host:next cat /usr/local/share/imp/deploy/imp-host.seccomp.json',
      'podman run --rm ghcr.io/zgeoff/imp-host:next cat /usr/local/share/imp/deploy/imp-host.service',
      'docker exec imp-host impz --version',
      'docker exec imp-host impz ls --json',
      'docker exec imp-host impz sleep web',
      'systemctl stop imp-host',
      '  unit: ExecStart=/usr/bin/docker run --name imp-host imp-host',
      'docker rm -f imp-host',
      'systemctl disable -q --now imp-docker-proxy',
      '  unit: ExecStart=/usr/bin/docker run --name imp-host imp-host',
      'systemctl daemon-reload',
      '  unit: ExecStart=/usr/bin/docker run --name imp-host imp-host',
      'docker network rm imp-host',
      'systemctl daemon-reload',
      '  unit: ExecStart=/usr/bin/podman run --name imp-host imp-host',
      'systemctl start imp-host',
      '  unit: ExecStart=/usr/bin/podman run --name imp-host imp-host',
      'curl -fsS http://127.0.0.1:7070/health',
      'podman exec imp-host impz --version',
      'podman exec imp-host impz info --json',
      'podman exec imp-host impz ls',
      '',
    ].join('\n'),
  );
});

test('it keeps the units of a Docker host as .baks, and names them in the rollback, on a move to Podman', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'ghcr.io/zgeoff/imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'ExecStart=/usr/bin/podman run --name imp-host imp-host\n',
      runsHost: false,
    }),
  );

  createStubBin(ctx.directoryPath, 'docker', buildStubHostDocker({ hostNetwork: ['imp-host'] }));
  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --name imp-host imp-host\n',
  );

  writeFileSync(
    join(ctx.directoryPath, 'imp-docker-proxy.service'),
    'ExecStart=/usr/bin/docker run --name imp-docker-proxy imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  const unitBackup = join(
    ctx.directoryPath,
    readdirSync(ctx.directoryPath)
      .filter((file) => file.startsWith('imp-host.service.bak-'))
      .join(''),
  );

  const proxyBackup = join(
    ctx.directoryPath,
    readdirSync(ctx.directoryPath)
      .filter((file) => file.startsWith('imp-docker-proxy.service.bak-'))
      .join(''),
  );

  expect(result.exitCode).toBe(0);

  expect(readFileSync(unitBackup, 'utf8')).toBe(
    'ExecStart=/usr/bin/docker run --name imp-host imp-host\n',
  );

  expect(readFileSync(proxyBackup, 'utf8')).toBe(
    'ExecStart=/usr/bin/docker run --name imp-docker-proxy imp-host\n',
  );

  expect(existsSync(join(ctx.directoryPath, 'imp-docker-proxy.service'))).toBeFalse();

  expect(result.stdout.toString()).toInclude(
    'upgrade: done, on Podman. To roll back to Docker: systemctl stop imp-host, ' +
      'then podman network rm imp-host, ' +
      `then mv ${unitBackup} ${join(ctx.directoryPath, 'imp-host.service')}, ` +
      `then mv ${proxyBackup} ${join(ctx.directoryPath, 'imp-docker-proxy.service')}, ` +
      'then systemctl daemon-reload, then systemctl enable --now imp-docker-proxy, ' +
      'then systemctl start imp-host.\n' +
      'upgrade: imp no longer needs Docker; docs/guides/operations.md#upgrade says how to remove it.\n',
  );
});

test("it leaves the env file and imp's data as they are on a move from Docker to Podman", () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'ghcr.io/zgeoff/imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'ExecStart=/usr/bin/podman run --name imp-host imp-host\n',
      runsHost: false,
    }),
  );

  createStubBin(ctx.directoryPath, 'docker', buildStubHostDocker({ hostNetwork: ['imp-host'] }));
  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --name imp-host imp-host\n',
  );

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.env'),
    'IMP_HOST_NETWORK=--network imp-host\nIMP_HOST_SUBNET6=fd00:7a::/64\n',
    { mode: 0o600 },
  );

  mkdirSync(join(ctx.directoryPath, 'imp-data', 'imps'), { recursive: true });
  writeFileSync(join(ctx.directoryPath, 'imp-data', 'imps', 'web.img'), 'disk of web');

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  expect(result.exitCode).toBe(0);

  expect(readFileSync(join(ctx.directoryPath, 'imp-host.env'), 'utf8')).toBe(
    'IMP_HOST_NETWORK=--network imp-host\nIMP_HOST_SUBNET6=fd00:7a::/64\n',
  );

  expect(
    readdirSync(ctx.directoryPath).filter((file) => file.startsWith('imp-host.env.')),
  ).toBeEmpty();

  expect(
    readdirSync(join(ctx.directoryPath, 'imp-data'), { recursive: true }),
  ).toIncludeSameMembers(['imps', join('imps', 'web.img')]);

  expect(readFileSync(join(ctx.directoryPath, 'imp-data', 'imps', 'web.img'), 'utf8')).toBe(
    'disk of web',
  );
});

test('it keeps the networks of a Docker host without IPv6, and rolls back without a proxy it never had', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'ghcr.io/zgeoff/imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'ExecStart=/usr/bin/podman run --name imp-host imp-host\n',
      runsHost: false,
    }),
  );

  createStubBin(ctx.directoryPath, 'docker', buildStubHostDocker({}));
  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --name imp-host imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  const calls = readFileSync(podman.calls, 'utf8');

  const unitBackup = join(
    ctx.directoryPath,
    readdirSync(ctx.directoryPath)
      .filter((file) => file.startsWith('imp-host.service.bak-'))
      .join(''),
  );

  expect(result.exitCode).toBe(0);
  expect(calls).not.toInclude('network rm');
  expect(calls).not.toInclude('imp-docker-proxy');
  expect(calls).toInclude('systemctl stop imp-host\ndocker rm -f imp-host\n');

  expect(result.stdout.toString()).toInclude(
    'upgrade: done, on Podman. To roll back to Docker: systemctl stop imp-host, ' +
      `then mv ${unitBackup} ${join(ctx.directoryPath, 'imp-host.service')}, ` +
      'then systemctl daemon-reload, then systemctl start imp-host.\n',
  );
});

test.each([
  ['host', 'podman inspect -f {{.Image}} imp-host'],
  ['pulled', 'podman image inspect -f {{.Id}} ghcr.io/zgeoff/imp-host:next'],
] as const)(
  'it stops before anything changes when the %s image id cannot be read',
  (failedInspect, lastCall) => {
    const ctx = setupTest();

    const podman = createStubBin(
      ctx.directoryPath,
      'podman',
      buildStubHostPodman({
        image: 'ghcr.io/zgeoff/imp-host:next',
        pulledLabel: 'no-docker',
        pulledUnit: 'ExecStart=/usr/bin/podman run --name imp-host imp-host\n',
        failedInspect,
      }),
    );

    createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

    writeFileSync(
      join(ctx.directoryPath, 'imp-host.service'),
      'ExecStart=/usr/bin/podman run --cap-drop ALL imp-host\n',
    );

    const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
      env: {
        PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
        IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
        IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
        IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
        IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
        IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
      },
    });

    expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
      exitCode: 125,
      stderr: 'Error: no such object\n',
    });

    expect(readFileSync(podman.calls, 'utf8')).toEndWith(`${lastCall}\n`);

    expect(readFileSync(join(ctx.directoryPath, 'imp-host.service'), 'utf8')).toBe(
      'ExecStart=/usr/bin/podman run --cap-drop ALL imp-host\n',
    );
  },
);

test("it stops with the rollback to Docker, and starts nothing, when Docker's network cannot be removed after the host stops", () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'ghcr.io/zgeoff/imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'ExecStart=/usr/bin/podman run --name imp-host imp-host\n',
      runsHost: false,
    }),
  );

  createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubHostDocker({ hostNetwork: ['imp-host'], networkInUse: true }),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --name imp-host imp-host\n',
  );

  writeFileSync(
    join(ctx.directoryPath, 'imp-docker-proxy.service'),
    'ExecStart=/usr/bin/docker run --name imp-docker-proxy imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  const calls = readFileSync(podman.calls, 'utf8');

  const proxyBackup = join(
    ctx.directoryPath,
    readdirSync(ctx.directoryPath)
      .filter((file) => file.startsWith('imp-docker-proxy.service.bak-'))
      .join(''),
  );

  expect(result.exitCode).toBe(1);

  expect(readFileSync(join(ctx.directoryPath, 'imp-host.service'), 'utf8')).toBe(
    'ExecStart=/usr/bin/docker run --name imp-host imp-host\n',
  );

  expect(
    readdirSync(ctx.directoryPath).filter((file) => file.startsWith('imp-host.service.')),
  ).toBeEmpty();

  expect(calls).toEndWith('docker network rm imp-host\n');

  expect(result.stderr.toString()).toBe(
    'Error response from daemon: error while removing network: network imp-host has active endpoints\n' +
      "upgrade: cannot remove Docker's imp-host network, whose bridge Podman needs; " +
      'imp-host is stopped; to roll back to Docker: systemctl stop imp-host, ' +
      `then mv ${proxyBackup} ${join(ctx.directoryPath, 'imp-docker-proxy.service')}, ` +
      'then systemctl daemon-reload, then systemctl enable --now imp-docker-proxy, ' +
      'then systemctl start imp-host\n',
  );
});

test('it moves a Docker host to Podman when the pulled image is the one Docker runs', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'ghcr.io/zgeoff/imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'ExecStart=/usr/bin/podman run --name imp-host imp-host\n',
      pulledIsRunning: true,
      runsHost: false,
    }),
  );

  createStubBin(ctx.directoryPath, 'docker', buildStubHostDocker({}));
  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --name imp-host imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  const calls = readFileSync(podman.calls, 'utf8');

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).not.toInclude('already runs');
  expect(calls).toInclude('systemctl start imp-host\n');
});

test('it refuses, before any imp sleeps, a Docker host whose imp-host network holds other containers', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'ghcr.io/zgeoff/imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'ExecStart=/usr/bin/podman run --name imp-host imp-host\n',
      runsHost: false,
    }),
  );

  createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubHostDocker({ awakeImps: ['web'], hostNetwork: ['imp-host', 'sidecar'] }),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --name imp-host imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  const calls = readFileSync(podman.calls, 'utf8');

  expect(result.exitCode).toBe(1);

  expect(result.stderr.toString()).toInclude(
    "upgrade: Docker's imp-host network also holds sidecar",
  );

  expect(readFileSync(join(ctx.directoryPath, 'imp-host.service'), 'utf8')).toBe(
    'ExecStart=/usr/bin/docker run --name imp-host imp-host\n',
  );

  expect(calls).not.toInclude('impz sleep');
  expect(calls).not.toInclude('systemctl');
});

test('it stops before any imp sleeps when the image cannot give its unit', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'ghcr.io/zgeoff/imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'ExecStart=/usr/bin/podman run --name imp-host imp-host\n',
      unreadableFile: '.service',
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    'ExecStart=/usr/bin/podman run --cap-drop ALL imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  const output = result.stdout.toString() + result.stderr.toString();
  const calls = readFileSync(podman.calls, 'utf8');

  expect(result.exitCode).toBe(1);
  expect(output).toInclude('cannot read');

  expect(readFileSync(join(ctx.directoryPath, 'imp-host.service'), 'utf8')).toBe(
    'ExecStart=/usr/bin/podman run --cap-drop ALL imp-host\n',
  );

  expect(existsSync(join(ctx.directoryPath, 'imp-host.seccomp.json'))).toBeFalse();
  expect(readdirSync(ctx.directoryPath).filter((file) => file.endsWith('.new'))).toBeEmpty();
  expect(calls).not.toInclude('impz ls');
  expect(calls).not.toInclude('systemctl');
});

test('it refuses, before any imp sleeps, an image whose unit runs Docker', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'ghcr.io/zgeoff/imp-host:older',
      pulledLabel: 'no-docker',
      pulledUnit: 'ExecStart=/usr/bin/docker run --name imp-host imp-host\n',
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    'ExecStart=/usr/bin/podman run --cap-drop ALL imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:older',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  const calls = readFileSync(podman.calls, 'utf8');

  expect(result.exitCode).toBe(1);

  expect(result.stderr.toString()).toInclude(
    'upgrade: the imp-host.service in ghcr.io/zgeoff/imp-host:older does not run Podman',
  );

  expect(readFileSync(join(ctx.directoryPath, 'imp-host.service'), 'utf8')).toBe(
    'ExecStart=/usr/bin/podman run --cap-drop ALL imp-host\n',
  );

  expect(readdirSync(ctx.directoryPath).filter((file) => file.endsWith('.new'))).toBeEmpty();
  expect(calls).not.toInclude('impz ls');
  expect(calls).not.toInclude('systemctl');
});

test('it stops before the restart when a unit cannot be installed', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'ghcr.io/zgeoff/imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'ExecStart=/usr/bin/podman run --name imp-host imp-host\n',
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);
  createStubBin(ctx.directoryPath, 'mv', `echo 'mv: cannot move' >&2; exit 1`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    'ExecStart=/usr/bin/podman run --cap-drop ALL imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  const output = result.stdout.toString() + result.stderr.toString();
  const calls = readFileSync(podman.calls, 'utf8');

  expect(result.exitCode).toBe(1);
  expect(output).toInclude('cannot install');
  expect(output).toInclude('nothing restarted, the host still runs old');
  expect(output).not.toInclude('installed');

  expect(readFileSync(join(ctx.directoryPath, 'imp-host.service'), 'utf8')).toBe(
    'ExecStart=/usr/bin/podman run --cap-drop ALL imp-host\n',
  );

  expect(readdirSync(ctx.directoryPath).filter((file) => file.endsWith('.new'))).toBeEmpty();
  expect(calls).not.toInclude('systemctl');
});

test('it moves to its own release when no image is named', () => {
  const ctx = setupTest();
  const pkgText = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const release = `ghcr.io/zgeoff/imp-host:${z.object({ version: z.string() }).parse(JSON.parse(pkgText)).version}`;

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: release,
      pulledLabel: 'no-docker',
      pulledUnit: `Environment=IMP_HOST_IMAGE=${release}\nExecStart=/usr/bin/podman run --name imp-host imp-host\n`,
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    'ExecStart=/usr/bin/podman run --cap-drop ALL imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: '',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  const calls = readFileSync(podman.calls, 'utf8');

  expect(result.exitCode).toBe(0);
  expect(calls).toInclude(`podman pull -q ${release}\n`);
  expect(existsSync(join(ctx.directoryPath, 'imp-host.env'))).toBeFalse();
});

test("it moves to the env file's pin over its own release", () => {
  const ctx = setupTest();
  const pkgText = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const release = `ghcr.io/zgeoff/imp-host:${z.object({ version: z.string() }).parse(JSON.parse(pkgText)).version}`;

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'imp-host:pinned',
      pulledLabel: 'no-docker',
      pulledUnit: `Environment=IMP_HOST_IMAGE=${release}\nExecStart=/usr/bin/podman run --name imp-host imp-host\n`,
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    'ExecStart=/usr/bin/podman run --cap-drop ALL imp-host\n',
  );

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.env'),
    'IMP_PORT=7070\nIMP_HOST_IMAGE=imp-host:pinned\n',
    {
      mode: 0o600,
    },
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: '',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  const calls = readFileSync(podman.calls, 'utf8');

  expect(result.exitCode).toBe(0);
  expect(calls).toInclude('podman pull -q imp-host:pinned\n');

  expect(readFileSync(join(ctx.directoryPath, 'imp-host.env'), 'utf8')).toBe(
    'IMP_PORT=7070\nIMP_HOST_IMAGE=imp-host:pinned\n',
  );

  expect(
    readdirSync(ctx.directoryPath).filter((file) => /^imp-host\.env\.bak-\d{8}-\d{6}$/v.test(file)),
  ).toBeEmpty();
});

test('it comments out the old template line, which is no pin, with a .bak of the file', () => {
  const ctx = setupTest();
  const pkgText = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const release = `ghcr.io/zgeoff/imp-host:${z.object({ version: z.string() }).parse(JSON.parse(pkgText)).version}`;

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: release,
      pulledLabel: 'no-docker',
      pulledUnit: `Environment=IMP_HOST_IMAGE=${release}\nExecStart=/usr/bin/podman run --name imp-host imp-host\n`,
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    'ExecStart=/usr/bin/podman run --cap-drop ALL imp-host\n',
  );

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.env'),
    'TAILSCALE_AUTHKEY=fake-key-for-tests\nIMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest\nIMP_PORT=7070\n',
    { mode: 0o600 },
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: '',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  const output = result.stdout.toString() + result.stderr.toString();
  const calls = readFileSync(podman.calls, 'utf8');

  const backups = readdirSync(ctx.directoryPath).filter((file) =>
    /^imp-host\.env\.bak-\d{8}-\d{6}$/v.test(file),
  );

  expect(result.exitCode).toBe(0);
  expect(calls).toInclude(`podman pull -q ${release}\n`);

  expect(readFileSync(join(ctx.directoryPath, 'imp-host.env'), 'utf8')).toBe(
    `TAILSCALE_AUTHKEY=fake-key-for-tests\n# IMP_HOST_IMAGE=${release}\nIMP_PORT=7070\n`,
  );

  expect(backups.map((file) => readFileSync(join(ctx.directoryPath, file), 'utf8'))).toStrictEqual([
    'TAILSCALE_AUTHKEY=fake-key-for-tests\nIMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest\nIMP_PORT=7070\n',
  ]);

  expect(statSync(join(ctx.directoryPath, 'imp-host.env')).mode & 0o777).toBe(0o600);

  expect(backups.map((file) => statSync(join(ctx.directoryPath, file)).mode & 0o777)).toStrictEqual(
    [0o600],
  );

  expect(output).toInclude('was the old template');
  expect(readdirSync(ctx.directoryPath).filter((file) => file.endsWith('.new'))).toBeEmpty();
});

test('it refuses an image from the environment that the unit would not run, before any imp sleeps', () => {
  const ctx = setupTest();
  const pkgText = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const release = `ghcr.io/zgeoff/imp-host:${z.object({ version: z.string() }).parse(JSON.parse(pkgText)).version}`;

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'ghcr.io/zgeoff/imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: `Environment=IMP_HOST_IMAGE=${release}\nExecStart=/usr/bin/podman run --name imp-host imp-host\n`,
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    'ExecStart=/usr/bin/podman run --cap-drop ALL imp-host\n',
  );

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.env'),
    'IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest\n',
    {
      mode: 0o600,
    },
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  const output = result.stdout.toString() + result.stderr.toString();
  const calls = readFileSync(podman.calls, 'utf8');

  expect(result.exitCode).toBe(1);

  expect(output).toInclude(
    `imp-host.service would run ${release}, not ghcr.io/zgeoff/imp-host:next`,
  );

  expect(readFileSync(join(ctx.directoryPath, 'imp-host.service'), 'utf8')).toBe(
    'ExecStart=/usr/bin/podman run --cap-drop ALL imp-host\n',
  );

  expect(readFileSync(join(ctx.directoryPath, 'imp-host.env'), 'utf8')).toBe(
    'IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest\n',
  );

  expect(readdirSync(ctx.directoryPath).filter((file) => file.endsWith('.new'))).toBeEmpty();
  expect(calls).not.toInclude('impz ls');
  expect(calls).not.toInclude('systemctl');
});

test("it counts a drop-in's image as its unit's own", () => {
  const ctx = setupTest();
  const pkgText = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const release = `ghcr.io/zgeoff/imp-host:${z.object({ version: z.string() }).parse(JSON.parse(pkgText)).version}`;

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'ghcr.io/zgeoff/imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: `Environment=IMP_HOST_IMAGE=${release}\nExecStart=/usr/bin/podman run --name imp-host imp-host\n`,
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    'ExecStart=/usr/bin/podman run --cap-drop ALL imp-host\n',
  );

  mkdirSync(join(ctx.directoryPath, 'imp-host.service.d'));

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service.d', 'image.conf'),
    '[Service]\nEnvironment=IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:next\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  const calls = readFileSync(podman.calls, 'utf8');

  expect(result.exitCode).toBe(0);
  expect(calls).toInclude('systemctl restart imp-host\n');
});

test('it reads the unit image from a quoted Environment= line that sets several variables', () => {
  const ctx = setupTest();
  const pkgText = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const release = `ghcr.io/zgeoff/imp-host:${z.object({ version: z.string() }).parse(JSON.parse(pkgText)).version}`;

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'ghcr.io/zgeoff/imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: `Environment="IMP_X=1" "IMP_HOST_IMAGE=${release}"\nExecStart=/usr/bin/podman run --name imp-host imp-host\n`,
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    'ExecStart=/usr/bin/podman run --cap-drop ALL imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  const output = result.stdout.toString() + result.stderr.toString();

  expect(result.exitCode).toBe(1);

  expect(output).toInclude(
    `imp-host.service would run ${release}, not ghcr.io/zgeoff/imp-host:next`,
  );
});

test('it takes the release-please marker lines out of the unit it installs', () => {
  const ctx = setupTest();
  const pkgText = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const release = `ghcr.io/zgeoff/imp-host:${z.object({ version: z.string() }).parse(JSON.parse(pkgText)).version}`;

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: release,
      pulledLabel: 'no-docker',
      pulledUnit: `# x-release-please-start-version\nEnvironment=IMP_HOST_IMAGE=${release}\nExecStart=/usr/bin/podman run --name imp-host imp-host\n# x-release-please-end\n`,
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    'ExecStart=/usr/bin/podman run --cap-drop ALL imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: '',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  expect(result.exitCode).toBe(0);

  expect(readFileSync(join(ctx.directoryPath, 'imp-host.service'), 'utf8')).toBe(
    `Environment=IMP_HOST_IMAGE=${release}\nExecStart=/usr/bin/podman run --name imp-host imp-host\n`,
  );
});

test('it migrates the old template line with a CR and blanks around it', () => {
  const ctx = setupTest();
  const pkgText = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const release = `ghcr.io/zgeoff/imp-host:${z.object({ version: z.string() }).parse(JSON.parse(pkgText)).version}`;

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: release,
      pulledLabel: 'no-docker',
      pulledUnit: `Environment=IMP_HOST_IMAGE=${release}\nExecStart=/usr/bin/podman run --name imp-host imp-host\n`,
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    'ExecStart=/usr/bin/podman run --cap-drop ALL imp-host\n',
  );

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.env'),
    'IMP_PORT=7070\r\n  IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest \r\n',
    { mode: 0o600 },
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: '',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  const calls = readFileSync(podman.calls, 'utf8');

  expect(result.exitCode).toBe(0);
  expect(calls).toInclude(`podman pull -q ${release}\n`);

  expect(readFileSync(join(ctx.directoryPath, 'imp-host.env'), 'utf8')).toBe(
    `IMP_PORT=7070\r\n# IMP_HOST_IMAGE=${release}\n`,
  );
});

test('it migrates a quoted old template line too', () => {
  const ctx = setupTest();
  const pkgText = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const release = `ghcr.io/zgeoff/imp-host:${z.object({ version: z.string() }).parse(JSON.parse(pkgText)).version}`;

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: release,
      pulledLabel: 'no-docker',
      pulledUnit: `Environment=IMP_HOST_IMAGE=${release}\nExecStart=/usr/bin/podman run --name imp-host imp-host\n`,
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    'ExecStart=/usr/bin/podman run --cap-drop ALL imp-host\n',
  );

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.env'),
    'IMP_PORT=7070\nIMP_HOST_IMAGE="ghcr.io/zgeoff/imp-host:latest"\n',
    { mode: 0o600 },
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: '',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  const calls = readFileSync(podman.calls, 'utf8');

  expect(result.exitCode).toBe(0);
  expect(calls).toInclude(`podman pull -q ${release}\n`);

  expect(readFileSync(join(ctx.directoryPath, 'imp-host.env'), 'utf8')).toBe(
    `IMP_PORT=7070\n# IMP_HOST_IMAGE=${release}\n`,
  );
});

test('it still writes the image lines and unit, without a restart, on a Podman host that runs the image already', () => {
  const ctx = setupTest();
  const pkgText = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const release = `ghcr.io/zgeoff/imp-host:${z.object({ version: z.string() }).parse(JSON.parse(pkgText)).version}`;

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: release,
      pulledLabel: 'no-docker',
      pulledUnit: `Environment=IMP_HOST_IMAGE=${release}\nExecStart=/usr/bin/podman run --name imp-host imp-host\n`,
      pulledIsRunning: true,
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    `Environment=IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest\nExecStart=/usr/bin/podman run --name imp-host imp-host\n`,
  );

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.env'),
    'IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest\n',
    {
      mode: 0o600,
    },
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: '',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  const output = result.stdout.toString() + result.stderr.toString();
  const calls = readFileSync(podman.calls, 'utf8');

  expect(result.exitCode).toBe(0);
  expect(output).toInclude('imp-host already runs old');

  expect(readFileSync(join(ctx.directoryPath, 'imp-host.env'), 'utf8')).toBe(
    `# IMP_HOST_IMAGE=${release}\n`,
  );

  expect(
    readdirSync(ctx.directoryPath)
      .filter((file) => /^imp-host\.env\.bak-\d{8}-\d{6}$/v.test(file))
      .map((file) => readFileSync(join(ctx.directoryPath, file), 'utf8')),
  ).toStrictEqual(['IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest\n']);

  expect(readFileSync(join(ctx.directoryPath, 'imp-host.service'), 'utf8')).toBe(
    `Environment=IMP_HOST_IMAGE=${release}\nExecStart=/usr/bin/podman run --name imp-host imp-host\n`,
  );

  expect(calls).toInclude('systemctl daemon-reload\n');
  expect(calls).not.toInclude('restart');
  expect(calls).not.toInclude('impz ls');
});

test('it refuses an env file that sets IMP_HOST_IMAGE empty before anything changes', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'ghcr.io/zgeoff/imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'ExecStart=/usr/bin/podman run --name imp-host imp-host\n',
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    'ExecStart=/usr/bin/podman run --cap-drop ALL imp-host\n',
  );

  writeFileSync(join(ctx.directoryPath, 'imp-host.env'), 'IMP_PORT=7070\nIMP_HOST_IMAGE=\n', {
    mode: 0o600,
  });

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: '',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  const output = result.stdout.toString() + result.stderr.toString();
  const calls = readFileSync(podman.calls, 'utf8');

  expect(result.exitCode).toBe(1);
  expect(output).toInclude('imp-host.env sets IMP_HOST_IMAGE= empty');

  expect(readFileSync(join(ctx.directoryPath, 'imp-host.env'), 'utf8')).toBe(
    'IMP_PORT=7070\nIMP_HOST_IMAGE=\n',
  );

  expect(calls.split('\n').filter((call) => call.startsWith('podman pull '))).toBeEmpty();
  expect(calls).not.toInclude('systemctl');
});

test('it refuses a host that runs the image already when its unit would run another', () => {
  const ctx = setupTest();
  const pkgText = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const release = `ghcr.io/zgeoff/imp-host:${z.object({ version: z.string() }).parse(JSON.parse(pkgText)).version}`;

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'ghcr.io/zgeoff/imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: `Environment=IMP_HOST_IMAGE=${release}\nExecStart=/usr/bin/podman run --name imp-host imp-host\n`,
      pulledIsRunning: true,
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    'ExecStart=/usr/bin/podman run --cap-drop ALL imp-host\n',
  );

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.env'),
    'IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest\n',
    {
      mode: 0o600,
    },
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  const output = result.stdout.toString() + result.stderr.toString();
  const calls = readFileSync(podman.calls, 'utf8');

  expect(result.exitCode).toBe(1);

  expect(output).toInclude(
    `imp-host.service would run ${release}, not ghcr.io/zgeoff/imp-host:next`,
  );

  expect(readFileSync(join(ctx.directoryPath, 'imp-host.service'), 'utf8')).toBe(
    'ExecStart=/usr/bin/podman run --cap-drop ALL imp-host\n',
  );

  expect(readFileSync(join(ctx.directoryPath, 'imp-host.env'), 'utf8')).toBe(
    'IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest\n',
  );

  expect(calls).not.toInclude('systemctl');
});

test('it sleeps each awake imp before the restart', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'ghcr.io/zgeoff/imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'ExecStart=/usr/bin/podman run --name imp-host imp-host\n',
      awakeImps: ['web', 'db'],
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    'ExecStart=/usr/bin/podman run --cap-drop ALL imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  const calls = readFileSync(podman.calls, 'utf8');

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toInclude('upgrade: web asleep\nupgrade: db asleep\n');

  expect(
    calls
      .split('\n')
      .filter((call) => /^(?:podman exec imp-host impz sleep|systemctl restart) /v.test(call)),
  ).toStrictEqual([
    'podman exec imp-host impz sleep web',
    'podman exec imp-host impz sleep db',
    'systemctl restart imp-host',
  ]);
});

test('it sleeps each awake imp with imp in a host image from before the CLI was impz, and asks again after the restart', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'ghcr.io/zgeoff/imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'ExecStart=/usr/bin/podman run --name imp-host imp-host\n',
      awakeImps: ['web', 'db'],
      runningCLI: 'imp',
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    'ExecStart=/usr/bin/podman run --cap-drop ALL imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  const calls = readFileSync(podman.calls, 'utf8');

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toInclude('upgrade: web asleep\nupgrade: db asleep\n');

  expect(
    calls.split('\n').filter((call) => /^(?:podman exec imp-host |systemctl restart )/v.test(call)),
  ).toStrictEqual([
    'podman exec imp-host impz --version',
    'podman exec imp-host imp ls --json',
    'podman exec imp-host imp sleep web',
    'podman exec imp-host imp sleep db',
    'systemctl restart imp-host',
    'podman exec imp-host impz --version',
    'podman exec imp-host imp info --json',
    'podman exec imp-host imp ls',
  ]);
});

test('it stops before anything restarts when an imp does not sleep', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'ghcr.io/zgeoff/imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'ExecStart=/usr/bin/podman run --name imp-host imp-host\n',
      awakeImps: ['web', 'db'],
      sleeplessImp: 'db',
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    'ExecStart=/usr/bin/podman run --cap-drop ALL imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  const calls = readFileSync(podman.calls, 'utf8');

  expect(result.exitCode).toBe(1);

  expect(result.stderr.toString()).toInclude(
    'upgrade: db did not sleep; the host still runs old\n',
  );

  expect(calls).not.toInclude('systemctl');

  expect(readFileSync(join(ctx.directoryPath, 'imp-host.service'), 'utf8')).toBe(
    'ExecStart=/usr/bin/podman run --cap-drop ALL imp-host\n',
  );
});

test('it stops a Docker host before anything changes when an imp does not sleep', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'ghcr.io/zgeoff/imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'ExecStart=/usr/bin/podman run --name imp-host imp-host\n',
      runsHost: false,
    }),
  );

  createStubBin(
    ctx.directoryPath,
    'docker',
    buildStubHostDocker({
      awakeImps: ['web', 'db'],
      sleeplessImp: 'db',
      hostNetwork: ['imp-host'],
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --name imp-host imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  const calls = readFileSync(podman.calls, 'utf8');

  expect(result.exitCode).toBe(1);

  expect(result.stderr.toString()).toInclude(
    'upgrade: db did not sleep; the host still runs old\n',
  );

  expect(calls).not.toInclude('systemctl');
  expect(calls).not.toInclude('docker rm');
  expect(calls).not.toInclude('network rm');
});

test('it fails the upgrade when impd is not ready in time after the restart', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'ghcr.io/zgeoff/imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'ExecStart=/usr/bin/podman run --name imp-host imp-host\n',
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":false}'`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    'ExecStart=/usr/bin/podman run --cap-drop ALL imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
      IMP_READY_TIMEOUT_S: '0',
    },
  });

  expect(result.exitCode).toBe(1);

  expect(result.stderr.toString()).toInclude(
    'upgrade: impd is not ready after 0 s; see: podman logs imp-host\n',
  );

  expect(readFileSync(podman.calls, 'utf8')).toInclude('systemctl restart imp-host\n');
});

test('it stops before anything restarts when it cannot rewrite the env file', () => {
  const ctx = setupTest();
  const pkgText = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const version = z.object({ version: z.string() }).parse(JSON.parse(pkgText)).version;

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: `ghcr.io/zgeoff/imp-host:${version}`,
      pulledLabel: 'no-docker',
      pulledUnit:
        `Environment=IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:${version}\n` +
        'ExecStart=/usr/bin/podman run --name imp-host imp-host\n',
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    'ExecStart=/usr/bin/podman run --cap-drop ALL imp-host\n',
  );

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.env'),
    'IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest\n',
    {
      mode: 0o600,
    },
  );

  // a dangling symlink where the rewrite writes the new file, which cp will not write through
  symlinkSync(
    join(ctx.directoryPath, 'missing', 'imp-host.env'),
    join(ctx.directoryPath, 'imp-host.env.new'),
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: '',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  expect(result.exitCode).toBe(1);

  expect(result.stderr.toString()).toInclude(
    `upgrade: cannot rewrite ${join(ctx.directoryPath, 'imp-host.env')}; nothing restarted, the host still runs old\n`,
  );

  expect(readFileSync(join(ctx.directoryPath, 'imp-host.env'), 'utf8')).toBe(
    'IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest\n',
  );

  expect(readFileSync(podman.calls, 'utf8')).not.toInclude('systemctl');
});

test('it gives the rollback to Docker when it cannot rewrite the env file after a Docker host stops', () => {
  const ctx = setupTest();
  const pkgText = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const version = z.object({ version: z.string() }).parse(JSON.parse(pkgText)).version;

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: `ghcr.io/zgeoff/imp-host:${version}`,
      pulledLabel: 'no-docker',
      pulledUnit:
        `Environment=IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:${version}\n` +
        'ExecStart=/usr/bin/podman run --name imp-host imp-host\n',
      runsHost: false,
    }),
  );

  createStubBin(ctx.directoryPath, 'docker', buildStubHostDocker({ hostNetwork: ['imp-host'] }));
  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --name imp-host imp-host\n',
  );

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.env'),
    'IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest\n',
    {
      mode: 0o600,
    },
  );

  // a dangling symlink where the rewrite writes the new file, which cp will not write through
  symlinkSync(
    join(ctx.directoryPath, 'missing', 'imp-host.env'),
    join(ctx.directoryPath, 'imp-host.env.new'),
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: '',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  expect(result.exitCode).toBe(1);

  expect(result.stderr.toString()).toInclude(
    `upgrade: cannot rewrite ${join(ctx.directoryPath, 'imp-host.env')}; imp-host is stopped; to roll back to Docker: ` +
      'systemctl stop imp-host, then systemctl daemon-reload, then systemctl start imp-host\n',
  );

  expect(readFileSync(join(ctx.directoryPath, 'imp-host.service'), 'utf8')).toBe(
    'ExecStart=/usr/bin/docker run --name imp-host imp-host\n',
  );
});

test('it warns, and still upgrades, when impz info fails', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'ghcr.io/zgeoff/imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'ExecStart=/usr/bin/podman run --name imp-host imp-host\n',
      impInfo: null,
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    'ExecStart=/usr/bin/podman run --cap-drop ALL imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  expect(result.exitCode).toBe(0);

  expect(result.stderr.toString()).toInclude(
    'upgrade: impz info failed; see the NOTE column below\n',
  );
});

test('it warns, and still upgrades, when it cannot read impz info', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'ghcr.io/zgeoff/imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'ExecStart=/usr/bin/podman run --name imp-host imp-host\n',
      impInfo: 'not json',
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    'ExecStart=/usr/bin/podman run --cap-drop ALL imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  expect(result.exitCode).toBe(0);

  expect(result.stderr.toString()).toInclude(
    'upgrade: could not read impz info; see the NOTE column below\n',
  );
});

test('it says when impd does not count cold boots', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'ghcr.io/zgeoff/imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'ExecStart=/usr/bin/podman run --name imp-host imp-host\n',
      impInfo: '{}',
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    'ExecStart=/usr/bin/podman run --cap-drop ALL imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  expect(result.exitCode).toBe(0);

  expect(result.stdout.toString()).toInclude(
    'upgrade: this impd does not count cold boots; see the NOTE column below\n',
  );
});

test('it reports the cold boots and the outdated parts that impd counts', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'ghcr.io/zgeoff/imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'ExecStart=/usr/bin/podman run --name imp-host imp-host\n',
      impInfo: '{"bootStatus":{"coldBoots":3,"outdated":{"kernel":2,"agent":0,"rootfs":1}}}',
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    'ExecStart=/usr/bin/podman run --cap-drop ALL imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  expect(result.exitCode).toBe(0);

  expect(result.stdout.toString()).toInclude(
    'upgrade: 3 imps will boot cold; outdated: 2 kernel, 1 rootfs\n',
  );
});

test('it reports no outdated parts when impd counts none', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubHostPodman({
      image: 'ghcr.io/zgeoff/imp-host:next',
      pulledLabel: 'no-docker',
      pulledUnit: 'ExecStart=/usr/bin/podman run --name imp-host imp-host\n',
      impInfo: '{"bootStatus":{"coldBoots":0,"outdated":{"kernel":0}}}',
    }),
  );

  createStubBin(ctx.directoryPath, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.directoryPath, 'imp-host.service'),
    'ExecStart=/usr/bin/podman run --cap-drop ALL imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${podman.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.directoryPath, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.directoryPath, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.directoryPath, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.directoryPath, 'imp-host.seccomp.json'),
    },
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toInclude('upgrade: 0 imps will boot cold; outdated: none\n');
});
