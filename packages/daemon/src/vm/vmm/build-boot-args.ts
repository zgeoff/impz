import type { SlotAddress } from '../../host-net/net/addressing';
import { GATEWAY_IP6 } from '../../host-net/net/addressing6';
import { ONLINE_MOVABLE_ARG, findRegionMib } from '../memory/elastic-memory';
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

  // above memoryMib, the guest gets a virtio-mem region to grow into
  // (docs/architecture/lifecycle/elastic-memory.md)
  readonly maxMemoryMib: number;
  readonly dns: readonly string[];

  // the CPU limit's cgroup; null runs the VM unlimited
  readonly cgroup: ImpCgroup | null;

  // the first boot of an imp from a template: the agent gives it a new
  // machine-id and ssh host keys (docs/guides/templates.md#identity)
  readonly isIdentityReset: boolean;

  // the imp's jail user; null runs Firecracker unjailed, as root
  readonly jail: JailUser | null;
}

// The kernel cmdline: the system drive (vdb) is the initial root and the agent
// PID 1; imp.* parameters configure the guest
// (docs/architecture/guest/agent.md#two-drives-and-a-kernel).
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
    ...(findRegionMib(plan.memoryMib, plan.maxMemoryMib) > 0 ? [ONLINE_MOVABLE_ARG] : []),
  ].join(' ');
}
