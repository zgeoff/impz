import { expect, test } from 'bun:test';
import type { WarmHost, WarmMove } from '@impz/api';
import { buildMockWarmHost } from '../../../testing/imp-ops/build-mock-warm-host';
import { buildMockWarmMove } from '../../../testing/imp-ops/build-mock-warm-move';
import { parseSubnet } from '../../host-net/net/addressing';
import { buildWarmMove, collectWarmMismatches, readWarmHost } from './warm-facts';

test('#readWarmHost reports the identity, the config and the storage a warm move needs', () => {
  const host = readWarmHost(
    {
      dataDir: '/var/lib/imp',
      subnet: parseSubnet('10.66.0.0/24'),
      brokerPort: 7081,
      dns: ['1.1.1.1', '8.8.8.8'],
    },
    {
      firecrackerVersion: 'v1.17.0',
      snapshotVersion: 'v12.0.0',
      hostKernel: '6.8.0',
      guestKernel: 'a'.repeat(64),
      systemDrive: 'b'.repeat(64),
      systemDrivePath: '/var/lib/imp/system/drives/bb.ext4',
      ipv6Prefix: null,
      cpuModel: 'AMD EPYC 9454P',
      cpuFlags: 'flags-sha',
    },
    'zfs',
  );

  expect(host).toStrictEqual({
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: '6.8.0',
    cpuModel: 'AMD EPYC 9454P',
    cpuFlags: 'flags-sha',
    dataDir: '/var/lib/imp',
    storage: 'zfs',
    subnet: '10.66.0.0/24',

    slotCount: 64,
    brokerPort: 7081,
    dns: ['1.1.1.1', '8.8.8.8'],
  });
});

test('#buildWarmMove takes the snapshot facts from the snapshot and the host facts from the host', () => {
  const move = buildWarmMove(
    3,
    'open',
    {
      firecrackerVersion: 'v1.16.0',
      snapshotVersion: 'v11.0.0',
      hostKernel: '6.6.0',
      guestKernel: 'a'.repeat(64),
      systemDrive: 'b'.repeat(64),
      cpuModel: 'AMD EPYC 7763',
      cpuFlags: 'old-flags',
      ipv6Prefix: 'fd00::/64',
      createdAt: 1_700_000_000_000,
      memoryMib: 512,
      ramMib: 512,
    },
    {
      firecrackerVersion: 'v1.17.0',
      snapshotVersion: 'v12.0.0',
      hostKernel: '6.8.0',
      cpuModel: 'AMD EPYC 9454P',
      cpuFlags: 'flags-sha',
      dataDir: '/var/lib/imp',
      storage: 'xfs',
      subnet: '10.66.0.0/16',
      slotCount: 16_384,
      brokerPort: 7081,
      dns: ['1.1.1.1'],
    },
  );

  expect(move).toStrictEqual({
    slot: 3,
    egressMode: 'open',
    snapshot: {
      firecrackerVersion: 'v1.16.0',
      snapshotVersion: 'v11.0.0',
      hostKernel: '6.6.0',
      cpuModel: 'AMD EPYC 7763',
      cpuFlags: 'old-flags',
      ipv6Prefix: 'fd00::/64',
    },
    host: {
      dataDir: '/var/lib/imp',
      storage: 'xfs',
      subnet: '10.66.0.0/16',
      brokerPort: 7081,
      dns: ['1.1.1.1'],
    },
  });
});

test('#buildWarmMove records a snapshot from an older impd without its CPU or IPv6 as null', () => {
  const move = buildWarmMove(
    0,
    'box',
    {
      firecrackerVersion: 'v1.16.0',
      snapshotVersion: 'v11.0.0',
      hostKernel: '6.6.0',
      guestKernel: 'a'.repeat(64),
      systemDrive: 'b'.repeat(64),
      createdAt: 1_700_000_000_000,
      memoryMib: 512,
      ramMib: 512,
    },
    buildMockWarmHost(),
  );

  expect(move.snapshot).toStrictEqual({
    firecrackerVersion: 'v1.16.0',
    snapshotVersion: 'v11.0.0',
    hostKernel: '6.6.0',
    cpuModel: null,
    cpuFlags: null,
    ipv6Prefix: null,
  });
});

test('#findWarmMismatches finds nothing when the target shares every fact of an open imp', () => {
  const target = buildMockWarmHost();

  const move = buildMockWarmMove({
    slot: 0,
    egressMode: 'open',
    snapshot: {
      firecrackerVersion: target.firecrackerVersion,
      snapshotVersion: target.snapshotVersion,
      hostKernel: target.hostKernel,
      cpuModel: target.cpuModel,
      cpuFlags: target.cpuFlags,
    },
    host: {
      dataDir: target.dataDir,
      storage: target.storage,
      subnet: target.subnet,
      brokerPort: target.brokerPort,
      dns: target.dns,
    },
  });

  expect(collectWarmMismatches(move, target)).toStrictEqual([]);
});

interface WarmMismatchRow {
  readonly fact: string;
  readonly snapshot: Partial<WarmMove['snapshot']>;
  readonly moveHost: Partial<WarmMove['host']>;
  readonly targetOverrides: Partial<WarmHost>;
  readonly expected: string[];
}

test.each<WarmMismatchRow>([
  {
    fact: 'the Firecracker version',
    snapshot: { firecrackerVersion: 'v1.16.0' },
    moveHost: {},
    targetOverrides: { firecrackerVersion: 'v1.17.0' },
    expected: ['the Firecracker version differs (v1.16.0 here, v1.17.0 there)'],
  },
  {
    fact: 'the snapshot format',
    snapshot: { snapshotVersion: 'v11.0.0' },
    moveHost: {},
    targetOverrides: { snapshotVersion: 'v12.0.0' },
    expected: ['the snapshot format differs (v11.0.0 here, v12.0.0 there)'],
  },
  {
    fact: 'the host kernel',
    snapshot: { hostKernel: '6.6.0' },
    moveHost: {},
    targetOverrides: { hostKernel: '6.8.0' },
    expected: ['the host kernel differs (6.6.0 here, 6.8.0 there)'],
  },
  {
    fact: 'the CPU model',
    snapshot: { cpuModel: 'AMD EPYC 7763' },
    moveHost: {},
    targetOverrides: { cpuModel: 'AMD EPYC 9454P' },
    expected: ['the CPU differs (AMD EPYC 7763 here, AMD EPYC 9454P there)'],
  },
  {
    fact: 'the CPU flags',
    snapshot: { cpuFlags: 'old-flags' },
    moveHost: {},
    targetOverrides: { cpuFlags: 'new-flags' },
    expected: ['the CPU flags differ'],
  },
  {
    fact: 'an unknown source CPU',
    snapshot: { cpuFlags: 'unknown' },
    moveHost: {},
    targetOverrides: {},
    expected: ['a CPU is unknown'],
  },
  {
    fact: 'an unknown target CPU',
    snapshot: {},
    moveHost: {},
    targetOverrides: { cpuFlags: 'unknown' },
    expected: ['a CPU is unknown'],
  },
  {
    fact: 'a snapshot without its CPU model',
    snapshot: { cpuModel: null },
    moveHost: {},
    targetOverrides: {},
    expected: ['the snapshot does not record its CPU (it is from an older impd)'],
  },
  {
    fact: 'a snapshot without its CPU flags',
    snapshot: { cpuFlags: null },
    moveHost: {},
    targetOverrides: {},
    expected: ['the snapshot does not record its CPU (it is from an older impd)'],
  },
  {
    fact: 'an IPv6 address',
    snapshot: { ipv6Prefix: 'fd00::/64' },
    moveHost: {},
    targetOverrides: {},
    expected: ["the imp has an IPv6 address in fd00::/64, this host's prefix"],
  },
  {
    fact: 'IMP_DATA_DIR',
    snapshot: {},
    moveHost: { dataDir: '/var/lib/imp' },
    targetOverrides: { dataDir: '/srv/imp' },
    expected: ['IMP_DATA_DIR differs (/var/lib/imp here, /srv/imp there)'],
  },
  {
    fact: 'the storage backend',
    snapshot: {},
    moveHost: { storage: 'xfs' },
    targetOverrides: { storage: 'zfs' },
    expected: ['the storage backend differs (xfs here, zfs there)'],
  },
  {
    fact: 'IMP_SUBNET',
    snapshot: {},
    moveHost: { subnet: '10.66.0.0/16' },
    targetOverrides: { subnet: '10.70.0.0/16' },
    expected: ['IMP_SUBNET differs (10.66.0.0/16 here, 10.70.0.0/16 there)'],
  },
  {
    fact: 'IMP_BROKER_PORT',
    snapshot: {},
    moveHost: { brokerPort: 7081 },
    targetOverrides: { brokerPort: 7082 },
    expected: ['IMP_BROKER_PORT differs (7081 here, 7082 there)'],
  },
  {
    fact: 'IMP_DNS',
    snapshot: {},
    moveHost: { dns: ['1.1.1.1', '8.8.8.8'] },
    targetOverrides: { dns: ['9.9.9.9'] },
    expected: ['IMP_DNS differs (1.1.1.1,8.8.8.8 here, 9.9.9.9 there)'],
  },
])('#findWarmMismatches refuses an open imp whose target differs in $fact', (row) => {
  const base = buildMockWarmHost();
  const target = { ...base, ...row.targetOverrides };

  const move = buildMockWarmMove({
    slot: 0,
    egressMode: 'open',
    snapshot: {
      firecrackerVersion: base.firecrackerVersion,
      snapshotVersion: base.snapshotVersion,
      hostKernel: base.hostKernel,
      cpuModel: base.cpuModel,
      cpuFlags: base.cpuFlags,
      ...row.snapshot,
    },
    host: {
      dataDir: base.dataDir,
      storage: base.storage,
      subnet: base.subnet,
      brokerPort: base.brokerPort,
      dns: base.dns,
      ...row.moveHost,
    },
  });

  expect(collectWarmMismatches(move, target)).toStrictEqual(row.expected);
});

test('#findWarmMismatches ignores IMP_DNS for a box imp, which asks the host resolver', () => {
  const target = buildMockWarmHost({ dns: ['9.9.9.9'] });

  const move = buildMockWarmMove({
    slot: 0,
    egressMode: 'box',
    snapshot: {
      firecrackerVersion: target.firecrackerVersion,
      snapshotVersion: target.snapshotVersion,
      hostKernel: target.hostKernel,
      cpuModel: target.cpuModel,
      cpuFlags: target.cpuFlags,
    },
    host: {
      dataDir: target.dataDir,
      storage: target.storage,
      subnet: target.subnet,
      brokerPort: target.brokerPort,
      dns: ['1.1.1.1', '8.8.8.8'],
    },
  });

  expect(collectWarmMismatches(move, target)).toStrictEqual([]);
});

test('#findWarmMismatches refuses a slot past the target slot count', () => {
  const target = buildMockWarmHost({ slotCount: 16 });

  const move = buildMockWarmMove({
    slot: 16,
    snapshot: {
      firecrackerVersion: target.firecrackerVersion,
      snapshotVersion: target.snapshotVersion,
      hostKernel: target.hostKernel,
      cpuModel: target.cpuModel,
      cpuFlags: target.cpuFlags,
    },
    host: {
      dataDir: target.dataDir,
      storage: target.storage,
      subnet: target.subnet,
      brokerPort: target.brokerPort,
      dns: target.dns,
    },
  });

  expect(collectWarmMismatches(move, target)).toStrictEqual([
    "slot 16 is past the target's 16 slots",
  ]);
});

test('#findWarmMismatches reports every fact that differs, in order', () => {
  const target = buildMockWarmHost({ slotCount: 16 });

  const move = buildMockWarmMove({
    slot: 20,
    snapshot: {
      firecrackerVersion: target.firecrackerVersion,
      snapshotVersion: target.snapshotVersion,
      hostKernel: target.hostKernel,
      cpuModel: null,
      cpuFlags: target.cpuFlags,
      ipv6Prefix: 'fd00::/64',
    },
    host: {
      dataDir: target.dataDir,
      storage: target.storage,
      subnet: target.subnet,
      brokerPort: target.brokerPort,
      dns: target.dns,
    },
  });

  expect(collectWarmMismatches(move, target)).toStrictEqual([
    'the snapshot does not record its CPU (it is from an older impd)',
    "the imp has an IPv6 address in fd00::/64, this host's prefix",
    "slot 20 is past the target's 16 slots",
  ]);
});
