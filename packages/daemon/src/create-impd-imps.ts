import { availableParallelism } from 'node:os';
import type { Config } from './config';
import type { ImpdStorage } from './create-impd-storage';
import type { Ipv6Plan } from './host-net/net/ipv6-plan';
import type { TailscaleStatus } from './host-net/net/tailscale-status';
import { readGuestNetBytes } from './host-net/net/tap-bytes';
import { createTapDevices } from './host-net/net/tap-devices';
import { createRamGovernor } from './imp-ops/governor/ram-governor';
import type { RamGovernor } from './imp-ops/governor/ram-governor';
import { createImpWatchdog } from './imp-ops/watchdog/imp-watchdog';
import type { ImpBoundaries, ImpdDeps } from './impd-deps';
import { growFilesystem } from './imps/imps/imp-disk';
import { createImpService } from './imps/imps/imp-service';
import type { ImpServiceDeps, Imps } from './imps/imps/imp-service';
import { createKernelOopsWatch } from './imps/imps/kernel-oops-watch';
import type { Broker } from './network/broker/broker-service';
import type { EgressService } from './network/egress/egress-service';
import { countImpsByState, listImps } from './platform/db/imps';
import { getImpdLogger } from './platform/process/get-impd-logger';
import { runCommand } from './platform/process/run-command';
import { startImpTelemetry } from './platform/telemetry/imp-telemetry';
import type { RamAdmission } from './vm/imps-contract/ram-admission';
import { createMemoryController } from './vm/memory/memory-controller';
import type { MemoryController } from './vm/memory/memory-controller';
import { createPluggedSizes } from './vm/memory/plugged-sizes';
import { readHostIdentity, readVmIdentity } from './vm/sleep/vm-identity';
import type { HostIdentity } from './vm/sleep/vm-identity';
import { buildImpPaths } from './vm/storage/data-layout';
import { createCpuCgroups } from './vm/vmm/cpu-cgroups';
import { createJails } from './vm/vmm/jail';
import { checkGuestMemoryMergeable, readKsmProfitMib } from './vm/vmm/ksm';
import { createVmRunner } from './vm/vmm/vm-runner';
import {
  readOwnedRamMib,
  readOwnedRamMibAsync,
  readResidentMibAsync,
  readRssMib,
  readThreadIds,
  readUnsharedRamMib,
  readVmMemory,
} from './vm/vmm/vm-stats';

export interface GovernedParts {
  readonly storage: ImpdStorage;
  readonly broker: Pick<Broker, 'readExecEnv'>;
  readonly egress: EgressService;
  readonly ipv6: Ipv6Plan | null;
  readonly readServiceUrl: (name: string) => string | null;
  readonly readTailscale: () => Promise<TailscaleStatus>;
}

export interface GovernedImps {
  readonly imps: Imps;
  readonly governor: RamGovernor;
  readonly memory: MemoryController;
  readonly identity: HostIdentity;
}

export function createImpdImps(
  config: Config,
  deps: Readonly<ImpdDeps>,
  parts: Readonly<GovernedParts>,
): GovernedImps {
  const cgroups = deps.cgroups ?? createCpuCgroups({ root: '/sys/fs/cgroup' });

  if (!cgroups.isEnforced) {
    const effect =
      config.jailerBin === null
        ? 'CPU limits are kept, not applied'
        : 'no jailed VM can start (IMP_JAILER=false runs them unjailed, with no limits)';

    getImpdLogger('cgroup').info('no cpu controller under /sys/fs/cgroup/imps; {effect}', {
      effect,
    });
  }

  const identity = (
    deps.readIdentity ?? ((files, prefix) => readHostIdentity(config.firecrackerBin, files, prefix))
  )(deps.systemFiles, parts.ipv6?.prefix.text ?? null);

  // a VM adopted from a start with the jailer on still needs its jail cleaned up
  const vms =
    deps.vms ??
    createVmRunner(
      createJails({
        jailerBin: config.jailerBin ?? 'jailer',
        firecrackerBin: Bun.which(config.firecrackerBin) ?? config.firecrackerBin,
        chrootBase: config.jailDir,
        run: deps.runCommand ?? runCommand,
        killCgroup: cgroups.kill,
      }),
      config.ksm?.execBin ?? null,
    );

  const {
    readRamMibAsync,
    readResidentMib,
    readKsmProfitMib: readProfitMib,
    ...host
  } = resolveImpBoundaries(deps.imps ?? {});

  const holder: { governor: RamGovernor | null } = { governor: null };

  const admission: RamAdmission = {
    admit: (request) => holder.governor?.admit(request) ?? Promise.resolve(),
    release: (id) => {
      holder.governor?.release(id);
    },
  };

  const pluggedSizes = createPluggedSizes();
  const memoryLimit = deps.imps?.memoryLimit ?? cgroups;

  const serviceDeps: ImpServiceDeps = {
    config,
    db: deps.db,
    images: parts.storage.images,
    taps: deps.taps ?? createTapDevices(),
    vms,
    storage: deps.storage,
    identity,
    ipv6: parts.ipv6,
    cgroups,
    memoryLimit,
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
    ...host,
    admission,
    pluggedSizes,
  };

  const imps = createImpService(serviceDeps, createImpWatchdog);
  const ksm = config.ksm;

  // KSM reports a VM's profit as negative while its metadata outweighs what it merged
  const readHeadroomMib = async (pids: readonly number[]): Promise<number> => {
    if (ksm === null) {
      return 0;
    }

    const profits = await Promise.all(pids.map((pid) => readProfitMib(pid)));

    const profitMib = profits.reduce<number>((sum, mib) => sum + (mib ?? 0), 0);

    return Math.ceil((Math.max(profitMib, 0) * ksm.headroomPercent) / 100);
  };

  const isBusy = (id: string) => imps.isImpBusy(id) || imps.tracker.count(id) > 0;

  const memory = createMemoryController({
    listElastic: async () => {
      const listed = await listImps(deps.db);

      return listed.flatMap((imp) => {
        if (imp.state !== 'running' || imp.pid === null || imp.maxMemoryMib <= imp.memoryMib) {
          return [];
        }

        const paths = buildImpPaths(config.dataDir, imp.id);

        return [
          {
            id: imp.id,
            name: imp.name,
            pid: imp.pid,
            memoryMib: imp.memoryMib,
            maxMemoryMib: imp.maxMemoryMib,
            paths,
            agentVersion: readVmIdentity(paths)?.agentVersion,
          },
        ];
      });
    },
    vms,
    isLocked: (id) => imps.isImpBusy(id),
    isBusy,
    tryWhileRunning: imps.tryWhileRunning,
    admitGrow: (request) => holder.governor?.admitGrow(request) ?? Promise.resolve(true),
    releaseGrow: (id) => {
      holder.governor?.releaseGrow(id);
    },
    limit: memoryLimit,
    readRamMib: (imp) => host.readRamMib(imp.pid, imp.paths.apiSocket),
    setPluggedMib: pluggedSizes.write,
    shrinkAfterMs: config.memoryShrinkAfterMs,
    ...(deps.now !== undefined && { now: deps.now }),
  });

  const governor = createRamGovernor({
    budgetMib: config.ramBudgetMib,
    listAwake: async () => {
      const listed = await listImps(deps.db);

      return listed.flatMap((imp) =>
        imp.state === 'running' && imp.pid !== null
          ? [
              {
                id: imp.id,
                name: imp.name,
                pid: imp.pid,
                apiSocket: buildImpPaths(config.dataDir, imp.id).apiSocket,
                lastActiveAt: imp.lastActiveAt.getTime(),
                holdUntil: imp.holdUntil?.getTime() ?? null,
              },
            ]
          : [],
      );
    },
    readRamMib: readRamMibAsync,
    readResidentMib,
    readHeadroomMib,
    isBusy,
    trySleepImp: imps.trySleepImp,
    readDiskFullError: imps.readDiskFullError,
    reclaim: memory.reclaimIdle,
    events: imps.events,
    ...(deps.now !== undefined && { now: deps.now }),
  });

  holder.governor = governor;

  startImpTelemetry({
    bus: imps.events,
    subscribeResources: imps.subscribeResources,
    readDiskUsedBytes: parts.storage.diskUsage.readExclusiveTotal,
    readStateCounts: () => countImpsByState(deps.db),
    readRebootReason: imps.readRebootReason,
    readRam: async () => {
      const usage = await governor.readUsage();

      return { usedMib: usage.usedMib, budgetMib: config.ramBudgetMib };
    },
  });

  return { imps, governor, memory, identity };
}

function resolveImpBoundaries(boundaries: Readonly<ImpBoundaries>) {
  const readRam = boundaries.readRamMib;
  const readRss = boundaries.readRssMib;
  const readRamMib = readRam ?? readOwnedRamMib;

  return {
    readRamMib,
    readRssMib: readRss ?? readRssMib,

    // the real reader reads smaps_rollup once for both values
    readVmMemory:
      readRam === undefined && readRss === undefined
        ? readVmMemory
        : (pid: number, apiSocket: string) => ({
            ramMib: readRamMib(pid, apiSocket),
            rssMib: (readRss ?? readRssMib)(pid, apiSocket),
          }),
    readRamMibAsync:
      readRam === undefined
        ? readOwnedRamMibAsync
        : (pid: number, apiSocket: string) => Promise.resolve(readRam(pid, apiSocket)),

    // a stand-in for the RAM reading has no KSM, so a VM owns every page it holds resident
    readResidentMib:
      readRam === undefined
        ? readResidentMibAsync
        : (pid: number, apiSocket: string) => Promise.resolve(readRam(pid, apiSocket)),
    readUnsharedRamMib: boundaries.readUnsharedRamMib ?? readUnsharedRamMib,
    checkGuestMerge: boundaries.checkGuestMerge ?? checkGuestMemoryMergeable,
    readKsmProfitMib: boundaries.readKsmProfitMib ?? readKsmProfitMib,
    growFilesystem: boundaries.growFilesystem ?? growFilesystem,
    hostCpus: boundaries.hostCpus ?? availableParallelism(),
    sleep: boundaries.sleep ?? Bun.sleep,
    sleepTiming: boundaries.sleepTiming ?? { now: () => performance.now(), sleep: Bun.sleep },
    kernelOops: boundaries.kernelOops ?? createKernelOopsWatch(),
    readThreadIds: boundaries.readThreadIds ?? ((pid: number) => readThreadIds(pid)),
    readNetBytes: boundaries.readNetBytes ?? ((tap: string) => readGuestNetBytes(tap)),
    ...(boundaries.openTap !== undefined && { openTap: boundaries.openTap }),
    ...(boundaries.now !== undefined && { now: boundaries.now }),
  };
}
