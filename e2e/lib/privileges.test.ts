import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findPrivilegeDrift, findSocketDrift, readExpectedPrivileges } from './privileges';

test('#findPrivilegeDrift passes a container run with the deploy privileges', () => {
  expect(
    findPrivilegeDrift(
      {
        Privileged: false,
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
      },
    ),
  ).toBeNull();
});

test('#findPrivilegeDrift passes a probed device and the dev instance’s loop device', () => {
  expect(
    findPrivilegeDrift(
      {
        Privileged: false,
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
      },
    ),
  ).toBeNull();
});

test('#findPrivilegeDrift flags a container run --privileged', () => {
  expect(
    findPrivilegeDrift(
      {
        Privileged: true,
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
      },
    ),
  ).toBe('it runs --privileged');
});

test('#findPrivilegeDrift flags a container that keeps the default capability set', () => {
  expect(
    findPrivilegeDrift(
      {
        Privileged: false,
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
      },
    ),
  ).toBe('it keeps the default capabilities (no --cap-drop ALL)');
});

test('#findPrivilegeDrift flags a missing capability', () => {
  expect(
    findPrivilegeDrift(
      {
        Privileged: false,
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
      },
    ),
  ).toBe('it adds CAP_SYS_ADMIN, not CAP_KILL CAP_SYS_ADMIN');
});

test('#findPrivilegeDrift flags AppArmor confinement', () => {
  expect(
    findPrivilegeDrift(
      {
        Privileged: false,
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
      },
    ),
  ).toBe('its security options are , not apparmor=unconfined');
});

test('#findPrivilegeDrift flags another seccomp profile', () => {
  expect(
    findPrivilegeDrift(
      {
        Privileged: false,
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
      },
    ),
  ).toBe('its seccomp profile is not deploy/imp-host.seccomp.json');
});

test('#findPrivilegeDrift flags a container with no seccomp profile', () => {
  expect(
    findPrivilegeDrift(
      {
        Privileged: false,
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
      },
    ),
  ).toBe('it has 0 seccomp options, not 1');
});

test('#findPrivilegeDrift flags a missing device', () => {
  expect(
    findPrivilegeDrift(
      {
        Privileged: false,
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
      },
    ),
  ).toBe('its devices lack /dev/net/tun and add none');
});

test('#findPrivilegeDrift flags a host device the deploy does not give', () => {
  expect(
    findPrivilegeDrift(
      {
        Privileged: false,
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
      },
    ),
  ).toBe('its devices lack none and add /dev/sda');
});

test('#readExpectedPrivileges reads the capabilities, options and devices of the deploy arguments', () => {
  const argsJson = JSON.stringify({
    privileges: [
      ['--init', '--cap-drop', 'ALL'],
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
  });
});

test('#readExpectedPrivileges reads deploy/imp-host.args.json without the module-loading capability', () => {
  const deploy = join(import.meta.dir, '..', '..', 'deploy');

  const expected = readExpectedPrivileges(
    readFileSync(join(deploy, 'imp-host.args.json'), 'utf8'),
    readFileSync(join(deploy, 'imp-host.seccomp.json'), 'utf8'),
  );

  expect(expected.caps).toIncludeAllMembers(['CAP_SYS_ADMIN', 'CAP_NET_ADMIN', 'CAP_KILL']);
  expect(expected.caps).not.toContain('CAP_SYS_MODULE');
  expect(expected.securityOpts).toStrictEqual(['apparmor=unconfined']);
  expect(expected.devices).toStrictEqual(['/dev/kvm', '/dev/net/tun']);
  expect(expected.optionalDevices).toStrictEqual(['/dev/zfs', '/dev/loop-control']);
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
