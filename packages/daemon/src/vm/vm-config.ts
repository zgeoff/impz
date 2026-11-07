import type { HostNetConfig } from '../host-net/host-net-config';

export type StorageBackendKind = 'xfs' | 'zfs';

export type WatchdogAction = 'report' | 'restart' | 'snapshot';

export interface KsmConfig {
  readonly execBin: string;
  readonly headroomPercent: number;
}

// Firecracker backs a 2 MiB guest with hugetlb pages, which only a UFFD
// handler restores.
interface HugePagesConfig {
  readonly handlerBin: string;

  // the most data a slept imp's memory file may hold for impd to warm it
  readonly warmCapMib: number;
}

// the RAM the budget keeps for the imps whose names match a pattern
export interface PriorityRam {
  readonly mib: number;
  readonly patterns: readonly string[];
}

export interface VmConfig extends HostNetConfig {
  readonly dataDir: string;
  readonly ramBudgetMib: number;
  readonly priorityRam: PriorityRam | null;

  // how long an elastic guest could give back a step before impd unplugs it
  readonly memoryShrinkAfterMs: number;
  readonly watchdogTimeoutS: number;
  readonly watchdogAction: WatchdogAction;
  readonly firecrackerBin: string;
  readonly jailerBin: string | null;
  readonly jailDir: string;
  readonly ksm: KsmConfig | null;
  readonly hugePages: HugePagesConfig | null;
  readonly kernelPath: string;

  // impd copies the kernel and system drive in on start, so a rebuild never changes a
  // file that a running VM has open
  readonly kernelSource: string | null;
  readonly systemDriveSource: string;
  readonly storageBackend: StorageBackendKind;
  readonly zfsRoot: string | null;
  readonly isUiomoveBugAllowed: boolean;
}
