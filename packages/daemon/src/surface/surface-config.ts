import type { ImpOpsConfig } from '../imp-ops/imp-ops-config';

export interface SurfaceConfig extends ImpOpsConfig {
  readonly sshPort: number | null;
  readonly sshAuthorizedKeys: boolean;
  readonly dashboardDir: string | null;
}
