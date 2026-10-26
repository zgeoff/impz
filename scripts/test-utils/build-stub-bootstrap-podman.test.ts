import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubBin } from '@impz/test-utils/create-stub-bin';
import { buildStubBootstrapPodman } from './build-stub-bootstrap-podman';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-bootstrap-podman-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return {
    directoryPath: directory,
  };
}

test('it answers the imp-host network in any format, and that it exists', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubBootstrapPodman({ hostNetwork: 'true br-imphost fd12::/64' }),
  );

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      `podman network inspect -f '{{.IPv6Enabled}} {{or .NetworkInterface "unnamed"}}' imp-host; podman network exists imp-host; echo $?`,
    ],
    { env: { PATH: `${podman.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect(result.stdout.toString()).toBe('true br-imphost fd12::/64\n0\n');
});

test('it lists the containers on the imp-host network, one per line', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubBootstrapPodman({
      hostNetwork: 'true br-imphost fd12::/64',
      networkContainers: ['imp-host', 'web'],
    }),
  );

  expect(
    Bun.spawnSync([
      join(podman.bin, 'podman'),
      'ps',
      '-a',
      '--filter',
      'network=imp-host',
      '--format',
      '{{.Names}}',
    ]).stdout.toString(),
  ).toBe('imp-host\nweb\n');
});

test('it fails the inspect of the imp-host network when there is none, as podman does', () => {
  const ctx = setupTest();
  const podman = createStubBin(ctx.directoryPath, 'podman', buildStubBootstrapPodman({}));

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      "podman network inspect -f '{{.IPv6Enabled}}' imp-host; echo $?; podman network exists imp-host; echo $?; podman ps -a --filter network=imp-host --format '{{.Names}}'; echo $?",
    ],
    { env: { PATH: `${podman.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect({ stdout: result.stdout.toString(), stderr: result.stderr.toString() }).toStrictEqual({
    stdout: '125\n1\n0\n',
    stderr:
      'Error: network imp-host: unable to find network with name or ID imp-host: network not found\n',
  });
});

test('it inspects an image the host holds and fails one it lacks', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubBootstrapPodman({ images: ['imp-host:1'] }),
  );

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      'podman image inspect imp-host:1; echo $?; podman image inspect imp-host:2; echo $?',
    ],
    { env: { PATH: `${podman.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect({ stdout: result.stdout.toString(), stderr: result.stderr.toString() }).toStrictEqual({
    stdout: '0\n125\n',
    stderr: 'Error: imp-host:2: image not known\n',
  });
});

test('it loads an archive without adding the image a caller then inspects', () => {
  const ctx = setupTest();
  const podman = createStubBin(ctx.directoryPath, 'podman', buildStubBootstrapPodman({}));

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      'podman load -q -i /srv/imp.tar; echo $?; podman image inspect imp-host:1; echo $?',
    ],
    { env: { PATH: `${podman.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect(result.stdout.toString()).toBe('0\n125\n');
});

test('it prints the seccomp profile of an image that carries one', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubBootstrapPodman({ images: ['imp-host:1'], seccompImages: ['imp-host:1'] }),
  );

  expect(
    Bun.spawnSync([
      join(podman.bin, 'podman'),
      'run',
      '--rm',
      'imp-host:1',
      'cat',
      '/usr/local/share/imp/deploy/imp-host.seccomp.json',
    ]).stdout.toString(),
  ).toBe('{}\n');
});

test('it fails the cat of the seccomp profile in an image without one', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubBootstrapPodman({ images: ['imp-host:1'] }),
  );

  const result = Bun.spawnSync([
    join(podman.bin, 'podman'),
    'run',
    '--rm',
    'imp-host:1',
    'cat',
    '/usr/local/share/imp/deploy/imp-host.seccomp.json',
  ]);

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: 'cat: /usr/local/share/imp/deploy/imp-host.seccomp.json: No such file or directory\n',
  });
});

test('it answers the imp-host container with what each of its fields sets', () => {
  const ctx = setupTest();

  const podman = createStubBin(
    ctx.directoryPath,
    'podman',
    buildStubBootstrapPodman({
      impInfo: '{"storage":{"backend":"xfs"}}',
      published: '7070/tcp -> 127.0.0.1:7070',
      dataMount: 'tank/imp zfs',
      ipv6Route: 'default via fd12::1 dev eth0',
      logs: 'impd: ipv6: on',
    }),
  );

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      'podman exec imp-host impz info; podman exec imp-host impz info --json; podman port imp-host; ' +
        'podman exec imp-host findmnt -n -r -o SOURCE,FSTYPE --mountpoint /var/lib/imp; ' +
        'podman exec imp-host ip -6 route show default; podman logs imp-host',
    ],
    { env: { PATH: `${podman.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect(result.stdout.toString()).toBe(
    '{"storage":{"backend":"xfs"}}\n{"storage":{"backend":"xfs"}}\n7070/tcp -> 127.0.0.1:7070\n' +
      'tank/imp zfs\ndefault via fd12::1 dev eth0\nimpd: ipv6: on\n',
  );
});

test('it answers the imp-host container with nothing for each field left out', () => {
  const ctx = setupTest();
  const podman = createStubBin(ctx.directoryPath, 'podman', buildStubBootstrapPodman({}));

  const result = Bun.spawnSync(
    ['bash', '-c', 'podman port imp-host; podman exec imp-host ip -6 route show default; echo $?'],
    { env: { PATH: `${podman.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect(result.stdout.toString()).toBe('0\n');
});

test('it fails a call bootstrap.sh does not make as unexpected', () => {
  const ctx = setupTest();
  const podman = createStubBin(ctx.directoryPath, 'podman', buildStubBootstrapPodman({}));
  const result = Bun.spawnSync([join(podman.bin, 'podman'), 'ps']);

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: 'unexpected: podman ps\n',
  });
});
