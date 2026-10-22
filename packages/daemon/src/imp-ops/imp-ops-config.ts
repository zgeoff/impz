import type { IdentityConfig } from '../identity/identity-config';
import type { BackupConfig } from './backup/backup-config';

export interface MovesConfig {
  readonly peerUrl: string | null;
  readonly testCidr: string | null;
}

export interface ImpOpsConfig extends IdentityConfig {
  readonly idleTimeoutS: number;

  // percent of one core, so a VM with several vCPUs can exceed 100
  readonly idleCpuPercent: number;
  readonly backup: BackupConfig | null;
  readonly moves: MovesConfig;
}
