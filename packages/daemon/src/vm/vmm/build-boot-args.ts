import type { SlotAddress } from '../../host-net/net/addressing';
import { GATEWAY_IP6 } from '../../host-net/net/addressing6';
import { ONLINE_MOVABLE_ARG, getRegionMib } from '../memory/elastic-memory';
import type { ImpPaths } from '../storage/data-layout';
import { BASE_BOOT_ARGS } from './configure-vm';
import type { ImpCgroup } from './cpu-cgroups';
import type { JailUser } from './jail';

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
