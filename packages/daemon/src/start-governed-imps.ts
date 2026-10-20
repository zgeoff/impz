import type { Broker } from './broker/broker-service';
import type { Config } from './config';
import type { ImpdDeps } from './create-impd';
import type { ImpdStorage } from './create-impd-storage';
import type { EgressService } from './egress/egress-service';
import { createGovernedImps } from './governor/create-governed-imps';
import { createKernelOopsWatch } from './imps/kernel-oops-watch';
import type { Ipv6Plan } from './net/ipv6-plan';
import type { TailscaleStatus } from './net/tailscale-status';
import { createTapDevices } from './net/tap-devices';
import { printLog } from './process/print-log';
import type { HostIdentity } from './sleep/vm-identity';
import type { CpuCgroups } from './vmm/cpu-cgroups';
import type { VmRunner } from './vmm/vm-runner';

export interface GovernedParts {
  readonly storage: ImpdStorage;
  readonly broker: Pick<Broker, 'readExecEnv'>;
  readonly egress: EgressService;
  readonly ipv6: Ipv6Plan | null;
  readonly cgroups: CpuCgroups;
  readonly readServiceUrl: (name: string) => string | null;
  readonly readTailscale: () => Promise<TailscaleStatus>;
}

// The imp service with its RAM governor and memory controller. A restart
// calls it again with a new runner, over the same database and storage.
export function startGovernedImps(
  config: Config,
  deps: Readonly<ImpdDeps>,
  parts: Readonly<GovernedParts>,
  identity: Readonly<HostIdentity>,
  vms: VmRunner,
): ReturnType<typeof createGovernedImps> {
  return createGovernedImps({
    cgroups: parts.cgroups,

    // each VM's memory.max follows what its elastic guest holds
    memoryLimit: parts.cgroups,
    config,
    db: deps.db,
    images: parts.storage.images,
    taps: deps.taps ?? createTapDevices(),
    vms,
    storage: deps.storage,
    identity,
    ipv6: parts.ipv6,
    log: deps.log ?? printLog,
    readExecEnv: parts.broker.readExecEnv,
    storageGate: parts.storage.storageGate,
    diskBudget: parts.storage.diskBudget,
    readDiskUsage: parts.storage.diskUsage.read,
    egress: parts.egress,
    readServiceUrl: parts.readServiceUrl,
    readTailnetHostname: async () => {
      const status = await parts.readTailscale();

      return status.hostname;
    },
    ...(deps.now !== undefined && { now: deps.now }),

    // the host's own taint flag; main.ts passes the watch it shares with storage
    kernelOops: createKernelOopsWatch(),
    ...deps.imps,
  });
}
