import type { OutdatedPart, SystemInfo } from '@impz/api';
import type { ImpRecord } from '../../platform/db/imps';
import { readColdBootReason, readSnapshotMeta } from '../../vm/sleep/snapshot-meta';
import { collectOutdatedParts, readVmIdentity } from '../../vm/sleep/vm-identity';
import type { HostIdentity } from '../../vm/sleep/vm-identity';
import type { ImpPaths } from '../../vm/storage/data-layout';

export interface BootStatus {
  readonly coldBootReason?: string;
  readonly outdated?: readonly OutdatedPart[];
}

export function readBootStatus(
  imp: Readonly<Pick<ImpRecord, 'state'>>,
  paths: Readonly<ImpPaths>,
  host: Readonly<HostIdentity>,
): BootStatus {
  if (imp.state === 'sleeping') {
    const meta = readSnapshotMeta(paths);

    if (meta === null) {
      return { coldBootReason: 'no snapshot it can load' };
    }

    const reason = readColdBootReason(meta, host);

    return reason === null
      ? withOutdated({}, collectOutdatedParts(meta, host))
      : { coldBootReason: reason };
  }

  if (imp.state !== 'running') {
    return {};
  }

  const vm = readVmIdentity(paths);

  if (vm === null) {
    return { outdated: ['impd'] };
  }

  const status = vm.bootReason === null ? {} : { coldBootReason: vm.bootReason };

  return withOutdated(status, collectOutdatedParts(vm, host));
}

function withOutdated(status: Readonly<BootStatus>, outdated: readonly OutdatedPart[]): BootStatus {
  return outdated.length === 0 ? status : { ...status, outdated };
}

export function countBootStatuses<T extends Pick<ImpRecord, 'state'>>(
  imps: readonly T[],
  read: (imp: T) => BootStatus,
): SystemInfo['bootStatus'] {
  const outdated = { firecracker: 0, kernel: 0, agent: 0 };
  let noIpv6 = 0;
  let coldBoots = 0;

  for (const imp of imps) {
    if (imp.state !== 'running' && imp.state !== 'sleeping') {
      continue;
    }

    const status = read(imp);
    const parts = status.outdated ?? [];

    // A running imp's next sleep records what it runs, and the host cannot load
    // a snapshot from an older Firecracker or with no identity.
    const bootsCold =
      imp.state === 'sleeping'
        ? status.coldBootReason !== undefined
        : parts.includes('firecracker') || parts.includes('impd');

    if (bootsCold) {
      coldBoots += 1;
    }

    for (const part of parts) {
      if (part === 'ipv6') {
        noIpv6 += 1;
      } else if (part !== 'impd') {
        outdated[part] += 1;
      }
    }
  }

  return { coldBoots, outdated: noIpv6 === 0 ? outdated : { ...outdated, ipv6: noIpv6 } };
}
