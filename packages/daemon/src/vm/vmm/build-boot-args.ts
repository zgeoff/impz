import { GATEWAY_IP6 } from '../../host-net/net/derive-guest-ip6';
import type { SlotAddress } from '../../host-net/net/derive-slot-address';
import type { ImpPaths } from '../storage/build-imp-paths';
import type { ImpCgroup } from './cpu-cgroups';
import type { JailUser } from './create-jails';
import type { HugePages } from './firecracker-client';
import { ONLINE_MOVABLE_ARG, getRegionMib } from './resolve-max-memory-mib';
import { BASE_BOOT_ARGS } from './setup-vm';

export interface VmPlan {
  readonly firecrackerBin: string;
  readonly kernelPath: string;
  readonly systemDrivePath: string;
  readonly paths: ImpPaths;
  readonly address: SlotAddress;
  readonly impId: string;
  readonly hostname: string;
  readonly vcpus: number;
  readonly memoryMib: number;
  readonly maxMemoryMib: number;

  // the host's own pages when left out
  readonly hugePages?: HugePages;
  readonly dns: readonly string[];
  readonly cgroup: ImpCgroup | null;
  readonly isIdentityReset: boolean;
  readonly jail: JailUser | null;
}

export function buildBootArgs(plan: Readonly<VmPlan>): string {
  return [
    ...BASE_BOOT_ARGS,
    `imp.id=${plan.impId}`,
    `imp.hostname=${plan.hostname}`,
    `imp.ip=${plan.address.guestIp}/${String(plan.address.prefixLength)}`,
    `imp.gw=${plan.address.hostIp}`,
    ...(plan.address.guestIp6 === null
      ? []
      : [`imp.ip6=${plan.address.guestIp6}/128`, `imp.gw6=${GATEWAY_IP6}`]),
    `imp.dns=${plan.dns.join(',')}`,
    ...(plan.isIdentityReset ? ['imp.reset_identity=1'] : []),
    ...(getRegionMib(plan.memoryMib, plan.maxMemoryMib) > 0 ? [ONLINE_MOVABLE_ARG] : []),
  ].join(' ');
}
