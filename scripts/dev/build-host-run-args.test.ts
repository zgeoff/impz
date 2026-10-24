import { expect, test } from 'bun:test';
import { buildDevLayout } from '../lib/build-dev-layout.ts';
import { buildHostRunArgs } from './build-host-run-args.ts';

test('it runs the host container with the deploy privileges, the repo, the data and the published ports', () => {
  expect(
    buildHostRunArgs({
      layout: buildDevLayout({ env: { IMP_DEV_PORT_OFFSET: '10' }, root: '/w/imp', cwd: '/w' }),
      checkout: {
        root: '/w/imp',
        rootPhysical: '/w/imp',
        hostImage: 'imp-host:dev-test',
        buildDir: '/w/imp/build',
      },
      env: { IMP_RAM_BUDGET_MIB: '4096', IMP_URL: 'http://elsewhere:7070' },
      privileges: ['--cap-drop', 'ALL'],
      hasEnvFile: true,
      tailscale: 'off',
      tailnetOAuthFile: null,
      acmeCAFile: null,
      registryCAFile: null,
      registryHost: null,
      kernel: '/src/kernel/out/vmlinux',
      systemDrive: '/src/build/imp-system.squashfs',
      uplinkMTU: '1360',
    }),
  ).toStrictEqual([
    'run',
    '-d',
    '--name',
    'imp-dev',
    '--hostname',
    'imp-dev',
    '--cap-drop',
    'ALL',
    '--device',
    '/dev/loop-control',
    '--device-cgroup-rule',
    'b 7:* rmw',
    '--dns',
    '1.1.1.1',
    '--dns',
    '8.8.8.8',
    '--env-file',
    '/w/imp/.env',
    '-v',
    '/w/imp:/src',
    '-v',
    '/w/imp:/w/imp',
    '-v',
    '/w/imp/.data/dev:/data',
    '-v',
    'imp-dev-docker:/run/imp-docker:ro',
    '-e',
    'DOCKER_HOST=unix:///run/imp-docker/docker.sock',
    '-p',
    '7080:7070',
    '-p',
    '7090:7080',
    '-p',
    '20010-20073:20000-20063',
    '-p',
    '127.0.0.1:2232:22',
    '-e',
    'IMP_STORAGE_GIB=200',
    '-e',
    'IMP_UPLINK_MTU=1360',
    '-e',
    'IMP_KERNEL=/src/kernel/out/vmlinux',
    '-e',
    'IMP_SYSTEM_DRIVE=/src/build/imp-system.squashfs',
    '-e',
    'IMP_DEFAULT_IMAGE=',
    '-e',
    'TAILSCALE_AUTHKEY=',
    '-e',
    'IMP_RAM_BUDGET_MIB=4096',
    '-e',
    'IMP_BROKER_TEST_UPSTREAMS=/data/broker-test-upstreams.json',
    '-e',
    'IMP_DASHBOARD_DIR=/src/packages/dashboard/dist',
    'imp-host:dev-test',
  ]);
});

test('it publishes no port for an unpublished instance and puts it on its network and address', () => {
  const args = buildHostRunArgs({
    layout: buildDevLayout({
      env: { IMP_DEV_PUBLISH: '0', IMP_DEV_IP: '172.30.0.9' },
      root: '/w/imp',
      cwd: '/w',
    }),
    checkout: {
      root: '/w/imp',
      rootPhysical: '/w/imp',
      hostImage: 'imp-host:dev-test',
      buildDir: '/w/imp/build',
    },
    env: { IMP_DEV_NETWORK: 'imp-moves', IMP_DEV_IP: '172.30.0.9' },
    privileges: [],
    hasEnvFile: false,
    tailscale: 'none',
    tailnetOAuthFile: null,
    acmeCAFile: null,
    registryCAFile: null,
    registryHost: null,
    kernel: '/src/kernel/out/vmlinux',
    systemDrive: '/src/build/imp-system.squashfs',
    uplinkMTU: '1500',
  });

  expect(args).not.toInclude('-p');
  expect(args.join(' ')).toInclude('--network imp-moves --ip 172.30.0.9 ');
});

test('it publishes the public MCP route on loopback when IMP_MCP_PUBLIC_URL is set', () => {
  const args = buildHostRunArgs({
    layout: buildDevLayout({ env: {}, root: '/w/imp', cwd: '/w' }),
    checkout: {
      root: '/w/imp',
      rootPhysical: '/w/imp',
      hostImage: 'imp-host:dev-test',
      buildDir: '/w/imp/build',
    },
    env: { IMP_MCP_PUBLIC_URL: 'https://mcp.example.test', IMP_MCP_PUBLIC_PORT: '7099' },
    privileges: [],
    hasEnvFile: false,
    tailscale: 'none',
    tailnetOAuthFile: null,
    acmeCAFile: null,
    registryCAFile: null,
    registryHost: null,
    kernel: '/src/kernel/out/vmlinux',
    systemDrive: '/src/build/imp-system.squashfs',
    uplinkMTU: '1500',
  });

  expect(args.join(' ')).toInclude('-p 127.0.0.1:2222:22 -p 127.0.0.1:7071:7099 ');
});

test('it passes IMP_HOST_ADDRESSES, which the egress suite lists a host address in', () => {
  const args = buildHostRunArgs({
    layout: buildDevLayout({ env: {}, root: '/w/imp', cwd: '/w' }),
    checkout: {
      root: '/w/imp',
      rootPhysical: '/w/imp',
      hostImage: 'imp-host:dev-test',
      buildDir: '/w/imp/build',
    },
    env: { IMP_HOST_ADDRESSES: '192.0.2.7/32' },
    privileges: [],
    hasEnvFile: false,
    tailscale: 'none',
    tailnetOAuthFile: null,
    acmeCAFile: null,
    registryCAFile: null,
    registryHost: null,
    kernel: '/src/kernel/out/vmlinux',
    systemDrive: '/src/build/imp-system.squashfs',
    uplinkMTU: '1500',
  });

  expect(args.join(' ')).toInclude(' -e IMP_HOST_ADDRESSES=192.0.2.7/32 ');
});

test.each([
  ['off', '-e TAILSCALE_AUTHKEY= '],
  ['key', '-e TAILSCALE_AUTHKEY '],
] as const)('it passes the Tailscale key setting %p by name only', (tailscale, expected) => {
  const args = buildHostRunArgs({
    layout: buildDevLayout({ env: {}, root: '/w/imp', cwd: '/w' }),
    checkout: {
      root: '/w/imp',
      rootPhysical: '/w/imp',
      hostImage: 'imp-host:dev-test',
      buildDir: '/w/imp/build',
    },
    env: { TAILSCALE_AUTHKEY: 'fake-tskey-never-in-argv' },
    privileges: [],
    hasEnvFile: false,
    tailscale,
    tailnetOAuthFile: null,
    acmeCAFile: null,
    registryCAFile: null,
    registryHost: null,
    kernel: '/src/kernel/out/vmlinux',
    systemDrive: '/src/build/imp-system.squashfs',
    uplinkMTU: '1500',
  });

  expect(args.join(' ')).toInclude(expected);
  expect(args.join(' ')).not.toInclude('fake-tskey-never-in-argv');
});

test('it passes the tailnet OAuth file, the ACME CA and the backup env file when set', () => {
  const args = buildHostRunArgs({
    layout: buildDevLayout({ env: {}, root: '/w/imp', cwd: '/w' }),
    checkout: {
      root: '/w/imp',
      rootPhysical: '/w/imp',
      hostImage: 'imp-host:dev-test',
      buildDir: '/w/imp/build',
    },
    env: { IMP_DEV_BACKUP_ENV_FILE: '/w/backup.env' },
    privileges: [],
    hasEnvFile: true,
    tailscale: 'none',
    tailnetOAuthFile: '/data/tailnet-oauth.json',
    acmeCAFile: '/src/.cache/pebble-ca.pem',
    registryCAFile: null,
    registryHost: null,
    kernel: '/src/kernel/out/vmlinux',
    systemDrive: '/src/build/imp-system.squashfs',
    uplinkMTU: '1500',
  }).join(' ');

  expect(args).toInclude('--env-file /w/imp/.env --env-file /w/backup.env ');
  expect(args).toInclude('-e IMP_TAILNET_OAUTH_FILE=/data/tailnet-oauth.json ');
  expect(args).toInclude('-e IMP_ACME_CA_FILE=/src/.cache/pebble-ca.pem ');
});
