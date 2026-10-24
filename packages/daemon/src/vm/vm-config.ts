import type { HostNetConfig } from '../host-net/host-net-config';

export type StorageBackendKind = 'xfs' | 'zfs';

export type WatchdogAction = 'report' | 'restart' | 'snapshot';

export interface KsmConfig {
  readonly execBin: string;
  readonly headroomPercent: number;
}

export interface VmConfig extends HostNetConfig {
  readonly dataDir: string;
  readonly ramBudgetMib: number;

  // how long an elastic guest could give back a step before impd unplugs it
  readonly memoryShrinkAfterMs: number;
  readonly watchdogTimeoutS: number;
  readonly watchdogAction: WatchdogAction;
  readonly firecrackerBin: string;
  readonly jailerBin: string | null;
  readonly jailDir: string;
  readonly ksm: KsmConfig | null;
  readonly kernelPath: string;

  // impd copies the kernel and system drive in on start, so a rebuild never changes a
  // file that a running VM has open
  readonly kernelSource: string | null;
  readonly systemDriveSource: string;
  readonly storageBackend: StorageBackendKind;
  readonly zfsRoot: string | null;
  readonly isUiomoveBugAllowed: boolean;
}
