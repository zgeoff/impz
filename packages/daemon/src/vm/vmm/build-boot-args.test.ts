import { expect, test } from 'bun:test';
import { readAgentFixture } from '@impz/test-utils/read-agent-fixture';
import * as z from 'zod';
import { deriveSlotAddress, parseSubnet } from '../../host-net/net/addressing';
import { parsePrefix64 } from '../../host-net/net/addressing6';
import { buildImpPaths } from '../storage/data-layout';
import { buildBootArgs } from './build-boot-args';

test('#buildBootArgs builds the kernel cmdline with the slot addressing', () => {
  const address = deriveSlotAddress(3, { subnet: parseSubnet('10.66.0.0/16'), portBase: 20_000 });

  expect(
    buildBootArgs({
      firecrackerBin: 'firecracker',
      kernelPath: '/k',
      systemDrivePath: '/s',
      paths: buildImpPaths('/var/lib/imp', 'id'),
      address,
      impId: 'id',
      hostname: 'dev',
      vcpus: 2,
      memoryMib: 1024,
      maxMemoryMib: 1024,
      dns: ['1.1.1.1', '8.8.8.8'],
      cgroup: null,
      isIdentityReset: false,
      jail: null,
    }),
  ).toBe(
    'console=ttyS0 reboot=k panic=1 pci=off i8042.noaux i8042.nomux i8042.nopnp i8042.dumbkbd root=/dev/vdb rootfstype=squashfs ro init=/imp-agent imp.id=id imp.hostname=dev imp.ip=10.66.0.14/30 imp.gw=10.66.0.13 imp.dns=1.1.1.1,8.8.8.8',
  );
});

test('#buildBootArgs asks for no identity reset on a later boot', () => {
  const address = deriveSlotAddress(3, { subnet: parseSubnet('10.66.0.0/16'), portBase: 20_000 });

  expect(
    buildBootArgs({
      firecrackerBin: 'firecracker',
      kernelPath: '/k',
      systemDrivePath: '/s',
      paths: buildImpPaths('/var/lib/imp', 'id'),
      address,
      impId: 'id',
      hostname: 'dev',
      vcpus: 2,
      memoryMib: 1024,
      maxMemoryMib: 1024,
      dns: ['1.1.1.1'],
      cgroup: null,
      isIdentityReset: false,
      jail: null,
    }),
  ).not.toInclude('imp.reset_identity');
});

test('#buildBootArgs asks for an identity reset on the first boot of a template copy', () => {
  const address = deriveSlotAddress(3, { subnet: parseSubnet('10.66.0.0/16'), portBase: 20_000 });

  expect(
    buildBootArgs({
      firecrackerBin: 'firecracker',
      kernelPath: '/k',
      systemDrivePath: '/s',
      paths: buildImpPaths('/var/lib/imp', 'id'),
      address,
      impId: 'id',
      hostname: 'dev',
      vcpus: 2,
      memoryMib: 1024,
      maxMemoryMib: 1024,
      dns: ['1.1.1.1'],
      cgroup: null,
      isIdentityReset: true,
      jail: null,
    }),
  ).toEndWith(' imp.dns=1.1.1.1 imp.reset_identity=1');
});

test('#buildBootArgs builds the cmdline the agent reads whole (agent/internal/contract)', () => {
  const prefix6 = parsePrefix64('fd12:3456:789a::/64');
  const subnet = parseSubnet('10.66.0.0/16');
  const address = deriveSlotAddress(3, { subnet, portBase: 20_000, prefix6 });

  expect(
    buildBootArgs({
      firecrackerBin: 'firecracker',
      kernelPath: '/k',
      systemDrivePath: '/s',
      paths: buildImpPaths('/var/lib/imp', 'imp_01hx'),
      address,
      impId: 'imp_01hx',
      hostname: 'web',
      vcpus: 2,
      memoryMib: 1024,
      maxMemoryMib: 4096,
      dns: ['10.66.0.13', '1.1.1.1'],
      cgroup: null,
      isIdentityReset: true,
      jail: null,
    }),
  ).toBe(
    z.object({ boot_args: z.string() }).parse(readAgentFixture('host/cmdline.json')).boot_args,
  );
});

test('#buildBootArgs names the /128 and the gateway fe80::1 with IPv6', () => {
  const prefix6 = parsePrefix64('fd12:3456:789a::/64');
  const subnet = parseSubnet('10.66.0.0/16');
  const address = deriveSlotAddress(3, { subnet, portBase: 20_000, prefix6 });

  expect(
    buildBootArgs({
      firecrackerBin: 'firecracker',
      kernelPath: '/k',
      systemDrivePath: '/s',
      paths: buildImpPaths('/var/lib/imp', 'id'),
      address,
      impId: 'id',
      hostname: 'dev',
      vcpus: 2,
      memoryMib: 1024,
      maxMemoryMib: 1024,
      dns: ['1.1.1.1'],
      cgroup: null,
      isIdentityReset: false,
      jail: null,
    }),
  ).toEndWith(
    ' imp.ip=10.66.0.14/30 imp.gw=10.66.0.13 imp.ip6=fd12:3456:789a::a42:e/128 imp.gw6=fe80::1 imp.dns=1.1.1.1',
  );
});

test('#buildBootArgs onlines hot-plugged memory movable for an elastic imp', () => {
  const address = deriveSlotAddress(3, { subnet: parseSubnet('10.66.0.0/16'), portBase: 20_000 });

  expect(
    buildBootArgs({
      firecrackerBin: 'firecracker',
      kernelPath: '/k',
      systemDrivePath: '/s',
      paths: buildImpPaths('/var/lib/imp', 'id'),
      address,
      impId: 'id',
      hostname: 'dev',
      vcpus: 2,
      memoryMib: 256,
      maxMemoryMib: 1024,
      dns: ['1.1.1.1'],
      cgroup: null,
      isIdentityReset: false,
      jail: null,
    }),
  ).toEndWith(' imp.dns=1.1.1.1 memhp_default_state=online_movable');
});

test('#buildBootArgs leaves hot-plugged memory alone for an imp that does not grow', () => {
  const address = deriveSlotAddress(3, { subnet: parseSubnet('10.66.0.0/16'), portBase: 20_000 });

  expect(
    buildBootArgs({
      firecrackerBin: 'firecracker',
      kernelPath: '/k',
      systemDrivePath: '/s',
      paths: buildImpPaths('/var/lib/imp', 'id'),
      address,
      impId: 'id',
      hostname: 'dev',
      vcpus: 2,
      memoryMib: 256,
      maxMemoryMib: 256,
      dns: ['1.1.1.1'],
      cgroup: null,
      isIdentityReset: false,
      jail: null,
    }),
  ).not.toInclude('memhp_default_state');
});
