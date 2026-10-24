import type { EgressPolicy } from '@impz/api';
import { deriveSlotAddress } from '../../host-net/net/addressing';
import type { SlotAddress } from '../../host-net/net/addressing';
import type { Ipv6Plan } from '../../host-net/net/ipv6-plan';
import type { GuestNetBytes } from '../../host-net/net/tap-bytes';
import type { TapDevices } from '../../host-net/net/tap-devices';
import { TEMPLATE_BUILD_UID } from '../../platform/db/imps';
import type { ImpRecord } from '../../platform/db/imps';
import type { ImpDatabase } from '../../platform/db/open-database';
import type { EventBus } from '../../platform/events/event-bus';
import { printLog } from '../../platform/process/print-log';
import type { openTapStream } from '../../vm/agent-client/exec-stream';
import type { RamAdmission } from '../../vm/imps-contract/ram-admission';
import { NO_MEMORY_LIMIT } from '../../vm/memory/memory-limit';
import type { MemoryLimit } from '../../vm/memory/memory-limit';
import { createPluggedSizes } from '../../vm/memory/plugged-sizes';
import type { PluggedSizes } from '../../vm/memory/plugged-sizes';
import type { HostIdentity } from '../../vm/sleep/vm-identity';
import type { ImpPaths } from '../../vm/storage/data-layout';
import { createDiskBudget } from '../../vm/storage/disk-budget';
import type { DiskBudget } from '../../vm/storage/disk-budget';
import type { CachedDiskUsage } from '../../vm/storage/disk-usage-cache';
import type { StorageBackend } from '../../vm/storage/storage-backend';
import { createStorageGate } from '../../vm/storage/storage-gate';
import type { StorageGate } from '../../vm/storage/storage-gate';
import { createBootTemplates } from '../../vm/templates/boot-templates';
import type { BootTemplates } from '../../vm/templates/boot-templates';
import type { CpuCgroups } from '../../vm/vmm/cpu-cgroups';
import type { JailUser } from '../../vm/vmm/jail';
import type { VmRunner } from '../../vm/vmm/vm-runner';
import { readCpuTicks } from '../../vm/vmm/vm-stats';
import type { BrokerExecEnv } from '../exec/broker-exec-env';
import type { ImageService } from '../images/image-service';
import type { ImpsConfig } from '../imps-config';
import { createSessionLogs } from '../session-logs/session-log-service';
import type { SessionLogs } from '../session-logs/session-log-service';
import { createSessionCache } from '../sessions/session-cache';
import type { SessionCache } from '../sessions/session-cache';
import { buildActivityTracker } from './activity-tracker';
import type { ActivityTracker } from './activity-tracker';
import { createMergeFlags } from './check-merge-flag';
import type { MergeFlags } from './check-merge-flag';
import { createInnerCache } from './inner-cache';
import type { InnerCache } from './inner-cache';
import type { KernelOopsWatch } from './kernel-oops-watch';
import { createResourceSampler } from './resource-sampler';
import type { ResourceSampler } from './resource-sampler';

interface ImpEgress {
  readonly requirePolicy: (policy: EgressPolicy) => void;
  readonly requireImp: (impId: string) => Promise<void>;
  readonly addSlot: (slot: number) => Promise<void>;
  readonly releaseSlot: (slot: number) => Promise<void>;
}

const NO_EGRESS: ImpEgress = {
  requirePolicy: () => {},
  requireImp: () => Promise.resolve(),
  addSlot: () => Promise.resolve(),
  releaseSlot: () => Promise.resolve(),
};

interface SleepTiming {
  readonly now: () => number;
  readonly sleep: (durationMs: number) => Promise<void>;
}

export interface ImpServiceDeps {
  readonly config: ImpsConfig;
  readonly db: ImpDatabase;
  readonly images: ImageService;
  readonly taps: TapDevices;
  readonly vms: VmRunner;
  readonly storage: StorageBackend;
  readonly log?: (message: string) => void;

  readonly admission?: RamAdmission;

  readonly identity: HostIdentity;

  readonly ipv6?: Ipv6Plan | null;
  readonly readRamMib: (pid: number, apiSocket: string) => number | null;
  readonly readRssMib: (pid: number, apiSocket: string) => number | null;

  readonly readVmMemory: (
    pid: number,
    apiSocket: string,
  ) => { readonly ramMib: number | null; readonly rssMib: number | null };

  readonly readUnsharedRamMib: (pid: number, apiSocket: string) => number | null;
  readonly checkGuestMerge: (pid: number) => Promise<boolean | null>;

  // An older tailnet node can hold the configured name, so the live name can
  // differ from it.
  readonly readTailnetHostname?: () => Promise<string | null>;

  readonly readServiceUrl?: (name: string) => string | null;

  readonly events?: EventBus;

  readonly now?: () => number;

  readonly sleep: (durationMs: number) => Promise<void>;

  readonly sleepTiming: SleepTiming;

  readonly readExecEnv?: (imp: ImpRecord, vsockPath: string) => Promise<BrokerExecEnv>;

  readonly storageGate?: StorageGate;

  readonly diskBudget?: DiskBudget;

  readonly openTap?: typeof openTapStream;

  readonly readDiskUsage?: (impId: string) => CachedDiskUsage | undefined;

  readonly growFilesystem: (disk: string) => Promise<boolean>;
  readonly egress?: ImpEgress;

  readonly cgroups: CpuCgroups;

  readonly hostCpus: number;

  readonly templates?: BootTemplates | null;

  readonly memoryLimit?: MemoryLimit;

  readonly pluggedSizes?: PluggedSizes;

  readonly kernelOops: KernelOopsWatch;

  readonly readThreadIds: (pid: number) => readonly number[] | null;

  readonly readNetBytes: (tap: string) => GuestNetBytes | null;
}

export interface ImpHost {
  readonly config: ImpsConfig;
  readonly db: ImpDatabase;
  readonly log: (message: string) => void;
  readonly identity: HostIdentity;
}

export interface ImpClock {
  readonly now: () => number;
  readonly sleep: (durationMs: number) => Promise<void>;
  readonly sleepTiming: SleepTiming;
}

export interface ImpVms {
  readonly images: ImageService;
  readonly taps: TapDevices;
  readonly vms: VmRunner;
  readonly storage: StorageBackend;
  readonly cgroups: CpuCgroups;
  readonly hostCpus: number;

  readonly templates: BootTemplates | null;
  readonly findPaths: (impId: string) => ImpPaths;
  readonly findAddress: (slot: number) => SlotAddress;

  readonly findJailUser: (imp: Readonly<ImpRecord>) => JailUser | null;
  readonly growFilesystem: (disk: string) => Promise<boolean>;
  readonly kernelOops: KernelOopsWatch;
}

export interface ImpMemory {
  readonly admission: RamAdmission | undefined;
  readonly readRamMib: (pid: number, apiSocket: string) => number | null;
  readonly readRssMib: (pid: number, apiSocket: string) => number | null;

  // With IMP_KSM a sleep records the unshared size instead of the Pss, since a
  // wake splits what KSM merged.
  readonly readSleepRamMib: (pid: number, apiSocket: string) => number | null;
  readonly checkGuestMerge: (pid: number) => Promise<boolean | null>;
  readonly mergeFlags: MergeFlags;
  readonly memoryLimit: MemoryLimit;

  readonly pluggedSizes: PluggedSizes;

  readonly resources: ResourceSampler;
}

export interface ImpGuest {
  readonly readExecEnv: (imp: ImpRecord, vsockPath: string) => Promise<BrokerExecEnv>;
  readonly tracker: ActivityTracker;
  readonly sessions: SessionCache;
  readonly inners: InnerCache;
  readonly sessionLogs: SessionLogs;
}

export interface ImpDisk {
  readonly storageGate: StorageGate;
  readonly diskBudget: DiskBudget;
  readonly readDiskUsage: (impId: string) => CachedDiskUsage | undefined;
}

interface ImpNetwork {
  readonly egress: ImpEgress;
  readonly readTailnetHostname: (() => Promise<string | null>) | undefined;
  readonly readServiceUrl: (name: string) => string | null;
}

export type ImpContext = ImpHost & ImpClock & ImpVms & ImpMemory & ImpGuest & ImpDisk & ImpNetwork;

export function createImpContext(deps: ImpServiceDeps): ImpContext {
  const slotPlan = {
    subnet: deps.config.subnet,
    portBase: deps.config.portBase,
    prefix6: deps.ipv6?.prefix ?? null,
  };

  const log = deps.log ?? printLog;
  const now = deps.now ?? Date.now;
  const cgroups = deps.cgroups;

  const diskBudget =
    deps.diskBudget ??
    createDiskBudget({
      storage: deps.storage,
      reserveBytes: deps.config.diskReserveBytes,
      log,
    });

  const records: ImpHost = {
    config: deps.config,
    db: deps.db,
    log,
    identity: deps.identity,
  };

  const clock: ImpClock = {
    now,
    sleep: deps.sleep,
    sleepTiming: deps.sleepTiming,
  };

  const vms: ImpVms = {
    images: deps.images,
    taps: deps.taps,
    vms: deps.vms,
    storage: deps.storage,
    cgroups,
    hostCpus: deps.hostCpus,
    templates:
      deps.templates === undefined ? createDefaultTemplates(deps, cgroups, log) : deps.templates,
    findPaths: (impId) => deps.storage.resolveImpPaths(impId),
    findAddress: (slot) => deriveSlotAddress(slot, slotPlan),
    findJailUser: (imp) =>
      deps.config.jailerBin === null || imp.jailUid === null
        ? null
        : { uid: imp.jailUid, gid: imp.jailUid },
    growFilesystem: deps.growFilesystem,
    kernelOops: deps.kernelOops,
  };

  const memory: ImpMemory = {
    admission: deps.admission,
    readRamMib: deps.readRamMib,
    readRssMib: deps.readRssMib,
    readSleepRamMib: deps.config.ksm === null ? deps.readRamMib : deps.readUnsharedRamMib,
    checkGuestMerge: deps.checkGuestMerge,
    mergeFlags: createMergeFlags(),
    memoryLimit: deps.memoryLimit ?? NO_MEMORY_LIMIT,
    pluggedSizes: deps.pluggedSizes ?? createPluggedSizes(),
    resources: createResourceSampler({
      now,
      readCpuStat: cgroups.readCpuStat,
      readCpuTicks,
      readNetBytes: deps.readNetBytes,
      readMemory: deps.readVmMemory,
      readThreadIds: deps.readThreadIds,
    }),
  };

  const guest: ImpGuest = {
    readExecEnv: deps.readExecEnv ?? (() => Promise.resolve({ kind: 'ungranted' })),
    tracker: buildActivityTracker(),
    sessions: createSessionCache(),
    inners: createInnerCache(),
    sessionLogs: createSessionLogs({
      limits: deps.config.sessionLog,
      requireRoom: diskBudget.requireRoom,
      now,
      log,
      ...(deps.openTap !== undefined && { openTap: deps.openTap }),
    }),
  };

  const disk: ImpDisk = {
    storageGate: deps.storageGate ?? createStorageGate(),
    diskBudget,
    readDiskUsage: deps.readDiskUsage ?? (() => {}),
  };

  const network: ImpNetwork = {
    egress: deps.egress ?? NO_EGRESS,
    readTailnetHostname: deps.readTailnetHostname,
    readServiceUrl: deps.readServiceUrl ?? (() => null),
  };

  return { ...records, ...clock, ...vms, ...memory, ...guest, ...disk, ...network };
}

function createDefaultTemplates(
  deps: Readonly<ImpServiceDeps>,
  cgroups: CpuCgroups,
  log: (message: string) => void,
): BootTemplates | null {
  if (!deps.config.bootTemplates) {
    return null;
  }

  return createBootTemplates({
    dataDir: deps.config.dataDir,
    identity: deps.identity,
    firecrackerBin: deps.config.firecrackerBin,
    kernelPath: deps.config.kernelPath,
    minGuestUptimeMs: deps.config.sleepMinGuestUptimeMs,
    bootReservePercent: deps.config.bootReservePercent,
    buildVm: deps.vms.createTemplateVm,
    taps: deps.taps,
    jail:
      deps.config.jailerBin === null ? null : { uid: TEMPLATE_BUILD_UID, gid: TEMPLATE_BUILD_UID },
    cgroups,
    admission: deps.admission,
    diskBudget: deps.diskBudget,
    log,
  });
}
