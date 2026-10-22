import type { HostNetConfig } from '../host-net/host-net-config';
import type { StorageBackendKind } from './storage/storage-backend';
import type { WatchdogAction } from './watchdog/agent-watchdog';

export interface KsmConfig {
  readonly execBin: string;
  readonly headroomPercent: number;
}

export interface VmConfig extends HostNetConfig {
  readonly dataDir: string;
  readonly ramBudgetMib: number;
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
