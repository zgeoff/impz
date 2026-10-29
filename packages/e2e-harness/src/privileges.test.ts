import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildPodmanHostConfig,
  findPrivilegeDrift,
  findSocketDrift,
  readExpectedPrivileges,
  readSeccompProfiles,
} from './privileges';

test('#findPrivilegeDrift passes a container run with the deploy privileges', () => {
  expect(
    findPrivilegeDrift(
      {
        Privileged: false,
        PidsLimit: null,
        CapAdd: ['CAP_SYS_ADMIN', 'CAP_KILL'],
        CapDrop: ['ALL'],
        SecurityOpt: ['apparmor=unconfined', 'seccomp={"defaultAction":"SCMP_ACT_ERRNO"}'],
        Devices: [{ PathOnHost: '/dev/kvm' }, { PathOnHost: '/dev/net/tun' }],
      },
      {
        caps: ['CAP_KILL', 'CAP_SYS_ADMIN'],
        securityOpts: ['apparmor=unconfined'],
        seccomp: { defaultAction: 'SCMP_ACT_ERRNO' },
        devices: ['/dev/kvm', '/dev/net/tun'],
        optionalDevices: ['/dev/zfs', '/dev/loop-control'],
        unlimitedPids: true,
      },
    ),
  ).toBeNull();
});

test('#findPrivilegeDrift passes a probed device and the dev instance’s loop device', () => {
  expect(
    findPrivilegeDrift(
      {
        Privileged: false,
        PidsLimit: null,
        CapAdd: ['CAP_SYS_ADMIN', 'CAP_KILL'],
        CapDrop: ['ALL'],
        SecurityOpt: ['apparmor=unconfined', 'seccomp={"defaultAction":"SCMP_ACT_ERRNO"}'],
        Devices: [
          { PathOnHost: '/dev/kvm' },
          { PathOnHost: '/dev/net/tun' },
          { PathOnHost: '/dev/zfs' },
          { PathOnHost: '/dev/loop-control' },
        ],
      },
      {
        caps: ['CAP_KILL', 'CAP_SYS_ADMIN'],
        securityOpts: ['apparmor=unconfined'],
        seccomp: { defaultAction: 'SCMP_ACT_ERRNO' },
        devices: ['/dev/kvm', '/dev/net/tun'],
        optionalDevices: ['/dev/zfs', '/dev/loop-control'],
        unlimitedPids: true,
      },
    ),
  ).toBeNull();
});

test('#findPrivilegeDrift flags a container run --privileged', () => {
  expect(
    findPrivilegeDrift(
      {
        Privileged: true,
        PidsLimit: null,
        CapAdd: ['CAP_SYS_ADMIN', 'CAP_KILL'],
        CapDrop: ['ALL'],
        SecurityOpt: ['apparmor=unconfined', 'seccomp={"defaultAction":"SCMP_ACT_ERRNO"}'],
        Devices: [{ PathOnHost: '/dev/kvm' }, { PathOnHost: '/dev/net/tun' }],
      },
      {
        caps: ['CAP_KILL', 'CAP_SYS_ADMIN'],
        securityOpts: ['apparmor=unconfined'],
        seccomp: { defaultAction: 'SCMP_ACT_ERRNO' },
        devices: ['/dev/kvm', '/dev/net/tun'],
        optionalDevices: ['/dev/zfs', '/dev/loop-control'],
        unlimitedPids: true,
      },
    ),
  ).toBe('it runs --privileged');
});

test('#findPrivilegeDrift flags a container that keeps the default capability set', () => {
  expect(
    findPrivilegeDrift(
      {
        Privileged: false,
        PidsLimit: null,
        CapAdd: ['CAP_SYS_ADMIN', 'CAP_KILL'],
        CapDrop: null,
        SecurityOpt: ['apparmor=unconfined', 'seccomp={"defaultAction":"SCMP_ACT_ERRNO"}'],
        Devices: [{ PathOnHost: '/dev/kvm' }, { PathOnHost: '/dev/net/tun' }],
      },
      {
        caps: ['CAP_KILL', 'CAP_SYS_ADMIN'],
        securityOpts: ['apparmor=unconfined'],
        seccomp: { defaultAction: 'SCMP_ACT_ERRNO' },
        devices: ['/dev/kvm', '/dev/net/tun'],
        optionalDevices: ['/dev/zfs', '/dev/loop-control'],
        unlimitedPids: true,
      },
    ),
  ).toBe('it keeps the default capabilities (no --cap-drop ALL)');
});

test("#buildPodmanHostConfig takes podman's effective capabilities and the text of its seccomp profile", () => {
  expect(
    buildPodmanHostConfig(
      {
        Privileged: false,
        PidsLimit: null,
        CapAdd: ['CAP_KILL', 'CAP_SYS_ADMIN'],
        CapDrop: ['CAP_CHOWN', 'CAP_NET_BIND_SERVICE'],
        SecurityOpt: ['seccomp=/w/imp/deploy/imp-host.seccomp.json', 'apparmor=unconfined'],
        Devices: [{ PathOnHost: '/dev/kvm' }],
      },
      ['CAP_KILL', 'CAP_SYS_ADMIN'],
      new Map([['/w/imp/deploy/imp-host.seccomp.json', '{"defaultAction":"SCMP_ACT_ERRNO"}']]),
    ),
  ).toStrictEqual({
    Privileged: false,
    PidsLimit: null,
    CapAdd: ['CAP_KILL', 'CAP_SYS_ADMIN'],
    CapDrop: ['ALL'],
    SecurityOpt: ['seccomp={"defaultAction":"SCMP_ACT_ERRNO"}', 'apparmor=unconfined'],
    Devices: [{ PathOnHost: '/dev/kvm' }],
  });
});

test('#readSeccompProfiles reads the text of each seccomp profile path and skips one it cannot read', () => {
  const texts = new Map([
    ['/w/imp/deploy/imp-host.seccomp.json', '{"defaultAction":"SCMP_ACT_ERRNO"}'],
  ]);

  expect(
    readSeccompProfiles(
      ['seccomp=/w/imp/deploy/imp-host.seccomp.json', 'seccomp=/gone.json', 'apparmor=unconfined'],
      (path) => texts.get(path) ?? null,
    ),
  ).toStrictEqual(
    new Map([['/w/imp/deploy/imp-host.seccomp.json', '{"defaultAction":"SCMP_ACT_ERRNO"}']]),
  );
});

test('#buildPodmanHostConfig shows a podman container that keeps a default capability as adding it', () => {
  const host = buildPodmanHostConfig(
    {
      Privileged: false,
      PidsLimit: null,
      CapAdd: ['CAP_KILL', 'CAP_SYS_ADMIN'],
      CapDrop: ['CAP_NET_BIND_SERVICE'],
      SecurityOpt: ['seccomp=/w/imp/deploy/imp-host.seccomp.json', 'apparmor=unconfined'],
      Devices: [{ PathOnHost: '/dev/kvm' }, { PathOnHost: '/dev/net/tun' }],
    },
    ['CAP_CHOWN', 'CAP_KILL', 'CAP_SYS_ADMIN'],
    new Map([['/w/imp/deploy/imp-host.seccomp.json', '{"defaultAction":"SCMP_ACT_ERRNO"}']]),
  );

  expect(
    findPrivilegeDrift(host, {
      caps: ['CAP_KILL', 'CAP_SYS_ADMIN'],
      securityOpts: ['apparmor=unconfined'],
      seccomp: { defaultAction: 'SCMP_ACT_ERRNO' },
      devices: ['/dev/kvm', '/dev/net/tun'],
      optionalDevices: ['/dev/zfs', '/dev/loop-control'],
      unlimitedPids: true,
    }),
  ).toBe('it adds CAP_CHOWN CAP_KILL CAP_SYS_ADMIN, not CAP_KILL CAP_SYS_ADMIN');
});

test('#findPrivilegeDrift flags a missing capability', () => {
  expect(
    findPrivilegeDrift(
      {
        Privileged: false,
        PidsLimit: null,
        CapAdd: ['CAP_SYS_ADMIN'],
        CapDrop: ['ALL'],
        SecurityOpt: ['apparmor=unconfined', 'seccomp={"defaultAction":"SCMP_ACT_ERRNO"}'],
        Devices: [{ PathOnHost: '/dev/kvm' }, { PathOnHost: '/dev/net/tun' }],
      },
      {
        caps: ['CAP_KILL', 'CAP_SYS_ADMIN'],
        securityOpts: ['apparmor=unconfined'],
        seccomp: { defaultAction: 'SCMP_ACT_ERRNO' },
        devices: ['/dev/kvm', '/dev/net/tun'],
        optionalDevices: ['/dev/zfs', '/dev/loop-control'],
        unlimitedPids: true,
      },
    ),
  ).toBe('it adds CAP_SYS_ADMIN, not CAP_KILL CAP_SYS_ADMIN');
});

test('#findPrivilegeDrift flags AppArmor confinement', () => {
  expect(
    findPrivilegeDrift(
      {
        Privileged: false,
        PidsLimit: null,
        CapAdd: ['CAP_SYS_ADMIN', 'CAP_KILL'],
        CapDrop: ['ALL'],
        SecurityOpt: ['seccomp={"defaultAction":"SCMP_ACT_ERRNO"}'],
        Devices: [{ PathOnHost: '/dev/kvm' }, { PathOnHost: '/dev/net/tun' }],
      },
      {
        caps: ['CAP_KILL', 'CAP_SYS_ADMIN'],
        securityOpts: ['apparmor=unconfined'],
        seccomp: { defaultAction: 'SCMP_ACT_ERRNO' },
        devices: ['/dev/kvm', '/dev/net/tun'],
        optionalDevices: ['/dev/zfs', '/dev/loop-control'],
        unlimitedPids: true,
      },
    ),
  ).toBe('its security options are , not apparmor=unconfined');
});

test('#findPrivilegeDrift flags another seccomp profile', () => {
  expect(
    findPrivilegeDrift(
      {
        Privileged: false,
        PidsLimit: null,
        CapAdd: ['CAP_SYS_ADMIN', 'CAP_KILL'],
        CapDrop: ['ALL'],
        SecurityOpt: ['apparmor=unconfined', 'seccomp={"defaultAction":"SCMP_ACT_ALLOW"}'],
        Devices: [{ PathOnHost: '/dev/kvm' }, { PathOnHost: '/dev/net/tun' }],
      },
      {
        caps: ['CAP_KILL', 'CAP_SYS_ADMIN'],
        securityOpts: ['apparmor=unconfined'],
        seccomp: { defaultAction: 'SCMP_ACT_ERRNO' },
        devices: ['/dev/kvm', '/dev/net/tun'],
        optionalDevices: ['/dev/zfs', '/dev/loop-control'],
        unlimitedPids: true,
      },
    ),
  ).toBe('its seccomp profile is not deploy/imp-host.seccomp.json');
});

test('#findPrivilegeDrift flags a container with no seccomp profile', () => {
  expect(
    findPrivilegeDrift(
      {
        Privileged: false,
        PidsLimit: null,
        CapAdd: ['CAP_SYS_ADMIN', 'CAP_KILL'],
        CapDrop: ['ALL'],
        SecurityOpt: ['apparmor=unconfined'],
        Devices: [{ PathOnHost: '/dev/kvm' }, { PathOnHost: '/dev/net/tun' }],
      },
      {
        caps: ['CAP_KILL', 'CAP_SYS_ADMIN'],
        securityOpts: ['apparmor=unconfined'],
        seccomp: { defaultAction: 'SCMP_ACT_ERRNO' },
        devices: ['/dev/kvm', '/dev/net/tun'],
        optionalDevices: ['/dev/zfs', '/dev/loop-control'],
        unlimitedPids: true,
      },
    ),
  ).toBe('it has 0 seccomp options, not 1');
});

test('#findPrivilegeDrift flags a missing device', () => {
  expect(
    findPrivilegeDrift(
      {
        Privileged: false,
        PidsLimit: null,
        CapAdd: ['CAP_SYS_ADMIN', 'CAP_KILL'],
        CapDrop: ['ALL'],
        SecurityOpt: ['apparmor=unconfined', 'seccomp={"defaultAction":"SCMP_ACT_ERRNO"}'],
        Devices: [{ PathOnHost: '/dev/kvm' }],
      },
      {
        caps: ['CAP_KILL', 'CAP_SYS_ADMIN'],
        securityOpts: ['apparmor=unconfined'],
        seccomp: { defaultAction: 'SCMP_ACT_ERRNO' },
        devices: ['/dev/kvm', '/dev/net/tun'],
        optionalDevices: ['/dev/zfs', '/dev/loop-control'],
        unlimitedPids: true,
      },
    ),
  ).toBe('its devices lack /dev/net/tun and add none');
});

test('#findPrivilegeDrift flags a host device the deploy does not give', () => {
  expect(
    findPrivilegeDrift(
      {
        Privileged: false,
        PidsLimit: null,
        CapAdd: ['CAP_SYS_ADMIN', 'CAP_KILL'],
        CapDrop: ['ALL'],
        SecurityOpt: ['apparmor=unconfined', 'seccomp={"defaultAction":"SCMP_ACT_ERRNO"}'],
        Devices: [
          { PathOnHost: '/dev/kvm' },
          { PathOnHost: '/dev/net/tun' },
          { PathOnHost: '/dev/sda' },
        ],
      },
      {
        caps: ['CAP_KILL', 'CAP_SYS_ADMIN'],
        securityOpts: ['apparmor=unconfined'],
        seccomp: { defaultAction: 'SCMP_ACT_ERRNO' },
        devices: ['/dev/kvm', '/dev/net/tun'],
        optionalDevices: ['/dev/zfs', '/dev/loop-control'],
        unlimitedPids: true,
      },
    ),
  ).toBe('its devices lack none and add /dev/sda');
});

test('#findPrivilegeDrift passes a podman container run with --pids-limit=-1', () => {
  expect(
    findPrivilegeDrift(
      {
        Privileged: false,
        PidsLimit: -1,
        CapAdd: ['CAP_SYS_ADMIN', 'CAP_KILL'],
        CapDrop: ['ALL'],
        SecurityOpt: ['apparmor=unconfined', 'seccomp={"defaultAction":"SCMP_ACT_ERRNO"}'],
        Devices: [{ PathOnHost: '/dev/kvm' }, { PathOnHost: '/dev/net/tun' }],
      },
      {
        caps: ['CAP_KILL', 'CAP_SYS_ADMIN'],
        securityOpts: ['apparmor=unconfined'],
        seccomp: { defaultAction: 'SCMP_ACT_ERRNO' },
        devices: ['/dev/kvm', '/dev/net/tun'],
        optionalDevices: ['/dev/zfs', '/dev/loop-control'],
        unlimitedPids: true,
      },
    ),
  ).toBeNull();
});

test("#findPrivilegeDrift flags a container that keeps podman's default pids limit", () => {
  expect(
    findPrivilegeDrift(
      {
        Privileged: false,
        PidsLimit: 2048,
        CapAdd: ['CAP_SYS_ADMIN', 'CAP_KILL'],
        CapDrop: ['ALL'],
        SecurityOpt: ['apparmor=unconfined', 'seccomp={"defaultAction":"SCMP_ACT_ERRNO"}'],
        Devices: [{ PathOnHost: '/dev/kvm' }, { PathOnHost: '/dev/net/tun' }],
      },
      {
        caps: ['CAP_KILL', 'CAP_SYS_ADMIN'],
        securityOpts: ['apparmor=unconfined'],
        seccomp: { defaultAction: 'SCMP_ACT_ERRNO' },
        devices: ['/dev/kvm', '/dev/net/tun'],
        optionalDevices: ['/dev/zfs', '/dev/loop-control'],
        unlimitedPids: true,
      },
    ),
  ).toBe('it caps its processes at 2048');
});

test('#readExpectedPrivileges reads the capabilities, options and devices of the deploy arguments', () => {
  const argsJson = JSON.stringify({
    privileges: [
      ['--init', '--pids-limit=-1', '--cap-drop', 'ALL'],
      ['--cap-add', 'SYS_ADMIN', '--cap-add', 'KILL'],
      ['--security-opt', 'apparmor=unconfined'],
      ['--security-opt', 'seccomp=/etc/imp/imp-host.seccomp.json'],
      ['--device', '/dev/net/tun', '--device', '/dev/kvm'],
    ],
    probed: [{ path: '/dev/zfs', args: ['--device', '/dev/zfs'] }],
  });

  expect(readExpectedPrivileges(argsJson, '{"defaultAction":"SCMP_ACT_ERRNO"}')).toStrictEqual({
    caps: ['CAP_KILL', 'CAP_SYS_ADMIN'],
    securityOpts: ['apparmor=unconfined'],
    seccomp: { defaultAction: 'SCMP_ACT_ERRNO' },
    devices: ['/dev/kvm', '/dev/net/tun'],
    optionalDevices: ['/dev/zfs', '/dev/loop-control'],
    unlimitedPids: true,
  });
});

test.each([
  ['--pids-limit=-1', ['--pids-limit=-1'], true],
  ['--pids-limit 0', ['--pids-limit', '0'], true],
  ['--pids-limit=2048', ['--pids-limit=2048'], false],
  ['no --pids-limit', [], false],
])('#readExpectedPrivileges reads %s as unlimited pids: %p', (_, words, unlimited) => {
  const argsJson = JSON.stringify({ privileges: [['--init', ...words]], probed: [] });

  expect(readExpectedPrivileges(argsJson, '{}').unlimitedPids).toBe(unlimited);
});

test('#readExpectedPrivileges reads deploy/imp-host.args.json without the module-loading capability', () => {
  const deploy = join(import.meta.dir, '..', '..', '..', 'deploy');

  const expected = readExpectedPrivileges(
    readFileSync(join(deploy, 'imp-host.args.json'), 'utf8'),
    readFileSync(join(deploy, 'imp-host.seccomp.json'), 'utf8'),
  );

  expect(expected.caps).toIncludeAllMembers(['CAP_SYS_ADMIN', 'CAP_NET_ADMIN', 'CAP_KILL']);
  expect(expected.caps).not.toContain('CAP_SYS_MODULE');
  expect(expected.securityOpts).toStrictEqual(['apparmor=unconfined']);
  expect(expected.devices).toStrictEqual(['/dev/kvm', '/dev/net/tun']);

  expect(expected.optionalDevices).toStrictEqual([
    '/dev/zfs',
    '/dev/userfaultfd',
    '/dev/loop-control',
  ]);

  expect(expected.unlimitedPids).toBe(true);
});

test('#findSocketDrift passes a mount that holds no Docker socket', () => {
  expect(findSocketDrift([{ Source: '/var/lib/imp', Destination: '/var/lib/imp' }])).toBeNull();
});

test('#findSocketDrift flags a mount of the host Docker socket', () => {
  expect(
    findSocketDrift([{ Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' }]),
  ).toBe('it mounts /var/run/docker.sock at /var/run/docker.sock');
});

test.each(['/var/run', '/run', '/var', '/'])(
  '#findSocketDrift flags a mount of %s, which holds the host Docker socket',
  (directory) => {
    expect(findSocketDrift([{ Source: directory, Destination: '/host' }])).toBe(
      `it mounts ${directory} at /host`,
    );
  },
);
