import { EGRESS_MODE_TRAITS, EgressModeSchema } from '@impz/api';
import type { WarmHost, WarmMove } from '@impz/api';
import { countSlots, formatSubnet } from '../../host-net/net/addressing';
import { UNKNOWN_CPU } from '../../vm/sleep/cpu-identity';
import type { SnapshotMeta } from '../../vm/sleep/snapshot-meta';
import type { HostIdentity } from '../../vm/sleep/vm-identity';
import type { ImpOpsConfig } from '../imp-ops-config';

export function readWarmHost(
  config: Pick<ImpOpsConfig, 'dataDir' | 'subnet' | 'brokerPort' | 'dns'>,
  identity: Readonly<HostIdentity>,
  storage: 'xfs' | 'zfs',
): WarmHost {
  return {
    firecrackerVersion: identity.firecrackerVersion,
    snapshotVersion: identity.snapshotVersion,
    hostKernel: identity.hostKernel,
    cpuModel: identity.cpuModel,
    cpuFlags: identity.cpuFlags,
    dataDir: config.dataDir,
    storage,
    subnet: formatSubnet(config.subnet),
    slotCount: countSlots(config.subnet),
    brokerPort: config.brokerPort,
    dns: [...config.dns],
  };
}

export function buildWarmMove(
  slot: number,
  egressMode: string,
  meta: Readonly<SnapshotMeta>,
  host: Readonly<WarmHost>,
): WarmMove {
  return {
    slot,
    egressMode,
    snapshot: {
      firecrackerVersion: meta.firecrackerVersion,
      snapshotVersion: meta.snapshotVersion,
      hostKernel: meta.hostKernel,
      cpuModel: meta.cpuModel ?? null,
      cpuFlags: meta.cpuFlags ?? null,
      ipv6Prefix: meta.ipv6Prefix ?? null,
    },
    host: {
      dataDir: host.dataDir,
      storage: host.storage,
      subnet: host.subnet,
      brokerPort: host.brokerPort,
      dns: host.dns,
    },
  };
}

export function collectWarmMismatches(
  move: Readonly<WarmMove>,
  target: Readonly<WarmHost>,
): string[] {
  const found: string[] = [];
  const snapshot = move.snapshot;

  const checkFact = (what: string, from: string, to: string) => {
    if (from !== to) {
      found.push(`${what} differs (${from} here, ${to} there)`);
    }
  };

  checkFact('the Firecracker version', snapshot.firecrackerVersion, target.firecrackerVersion);
  checkFact('the snapshot format', snapshot.snapshotVersion, target.snapshotVersion);
  checkFact('the host kernel', snapshot.hostKernel, target.hostKernel);

  if (snapshot.cpuModel === null || snapshot.cpuFlags === null) {
    found.push('the snapshot does not record its CPU (it is from an older impd)');
  } else if (snapshot.cpuFlags === UNKNOWN_CPU || target.cpuFlags === UNKNOWN_CPU) {
    found.push('a CPU is unknown');
  } else {
    checkFact('the CPU', snapshot.cpuModel, target.cpuModel);

    if (snapshot.cpuFlags !== target.cpuFlags) {
      found.push('the CPU flags differ');
    }
  }

  // A routed /64 belongs to one host, and `auto` makes a ULA per host.
  if (snapshot.ipv6Prefix !== null) {
    found.push(`the imp has an IPv6 address in ${snapshot.ipv6Prefix}, this host's prefix`);
  }

  checkFact('IMP_DATA_DIR', move.host.dataDir, target.dataDir);
  checkFact('the storage backend', move.host.storage, target.storage);
  checkFact('IMP_SUBNET', move.host.subnet, target.subnet);
  checkFact('IMP_BROKER_PORT', String(move.host.brokerPort), String(target.brokerPort));

  if (isOpenMode(move.egressMode)) {
    checkFact('IMP_DNS', move.host.dns.join(','), target.dns.join(','));
  }

  if (move.slot >= target.slotCount) {
    found.push(`slot ${String(move.slot)} is past the target's ${String(target.slotCount)} slots`);
  }

  return found;
}

function isOpenMode(egressMode: string): boolean {
  const mode = EgressModeSchema.safeParse(egressMode);

  return mode.success && EGRESS_MODE_TRAITS[mode.data].isOpen;
}
