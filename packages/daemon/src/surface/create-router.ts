import type { TailscaleStatus } from '../host-net/net/tailscale-status';
import type { TokenStore } from '../identity/auth/token-store';
import type { McpAuth } from '../identity/oauth/create-mcp-auth';
import type { BackupService } from '../imp-ops/backup/backup-service';
import type { CheckpointService } from '../imp-ops/checkpoints/checkpoint-service';
import type { MoveService } from '../imp-ops/moves/move-service';
import type { Repeat } from '../imps/images/build/build-event-stream';
import type { ImageService } from '../imps/images/image-service';
import type { TemplateService } from '../imps/images/template-service';
import type { ImpService } from '../imps/imps/imp-service';
import type { Broker } from '../network/broker/broker-service';
import type { EgressService } from '../network/egress/egress-service';
import type { DnsTokenStatus } from '../network/https/dns/dns-token';
import type { ExposureService } from '../network/https/exposure-service';
import type { PublicRecordsLink } from '../network/https/public-records-link';
import type { NetworkService } from '../network/networks/network-service';
import type { TailnetNamesStatus } from '../network/tailnet-names/tailnet-names';
import type { ApiAudit } from '../platform/audit/api-audit';
import type { DatabaseCopyFile } from '../platform/db/database-copy';
import type { RamGovernor } from '../vm/governor/ram-governor';
import type { DiskBudget } from '../vm/storage/disk-budget';
import type { StorageBackend } from '../vm/storage/storage-backend';
import type { StorageGcService } from '../vm/storage/storage-gc';
import type { SystemFileInfo } from '../vm/storage/system-file-info';
import type { KsmHostStats } from '../vm/vmm/ksm';
import { buildAuditRoutes } from './build-audit-routes';
import { buildCallerImps } from './build-caller-imps';
import { createBackupRoutes } from './create-backup-routes';
import { createCheckpointRoutes } from './create-checkpoint-routes';
import { createEventRoutes } from './create-event-routes';
import { createExecRoutes } from './create-exec-routes';
import { createFileRoutes } from './create-file-routes';
import { createGrantRoutes } from './create-grant-routes';
import { createImageRoutes } from './create-image-routes';
import { createImpRoutes } from './create-imp-routes';
import { createImplementer } from './create-implementer';
import { createLeaseRoutes } from './create-lease-routes';
import { createMoveRoutes } from './create-move-routes';
import { createNetworkRoutes } from './create-network-routes';
import { createOAuthRoutes } from './create-oauth-routes';
import { createSecretRoutes } from './create-secret-routes';
import { createServiceRoutes } from './create-service-routes';
import { createSessionRoutes } from './create-session-routes';
import { createSystemRoutes } from './create-system-routes';
import { createTokenRoutes } from './create-token-routes';
import type { ExecTickets } from './exec/exec-tickets';
import type { SurfaceConfig } from './surface-config';

export interface RouterDeps {
  readonly config: SurfaceConfig;
  readonly exposure: ExposureService;
  readonly writeDatabaseCopy: (name: string) => Promise<DatabaseCopyFile>;
  readonly imps: ImpService;
  readonly images: ImageService;
  readonly governor: RamGovernor;
  readonly checkpoints: CheckpointService;
  readonly templates: TemplateService;
  readonly broker: Broker;
  readonly egress: Pick<EgressService, 'readPolicy' | 'setPolicy' | 'isEnforced'>;
  readonly networks: NetworkService;
  readonly backups: BackupService | null;
  readonly moves: Omit<MoveService, 'respond' | 'recover'>;
  readonly firecrackerVersion: string | null;
  readonly systemFiles: SystemFileInfo;
  readonly readKsmHostStats?: () => KsmHostStats | null;
  readonly readTailscale: () => Promise<TailscaleStatus>;
  readonly readTailnetNames: (() => TailnetNamesStatus) | null;
  readonly publicRecords: PublicRecordsLink;
  readonly checkDnsToken: (() => Promise<DnsTokenStatus>) | null;
  readonly execTickets: ExecTickets;
  readonly storage: Pick<StorageBackend, 'kind' | 'readWarnings'>;
  readonly diskBudget: Pick<DiskBudget, 'readStatus' | 'withRoom'>;
  readonly gc: Pick<StorageGcService, 'runGc'>;
  readonly now: () => number;
  readonly log: (message: string) => void;
  readonly audit: ApiAudit;
  readonly tokens: TokenStore;
  readonly imageKeepaliveMs: number;
  readonly imageKeepaliveRepeat?: Repeat;
  readonly oauth: McpAuth;
}

export function createRouter(deps: RouterDeps) {
  const os = createImplementer(deps);
  const views = buildCallerImps(deps.imps);

  return os.router({
    imps: createImpRoutes(os, deps, views),
    leases: createLeaseRoutes(os, deps),
    checkpoints: createCheckpointRoutes(os, deps, views),
    moves: createMoveRoutes(os, deps),
    backups: createBackupRoutes(os, deps),
    images: createImageRoutes(os, deps),
    exec: createExecRoutes(os, deps),
    sessions: createSessionRoutes(os, deps),
    services: createServiceRoutes(os, deps),
    files: createFileRoutes(os, deps),
    secrets: createSecretRoutes(os, deps),
    networks: createNetworkRoutes(os, deps),
    grants: createGrantRoutes(os, deps),
    audit: buildAuditRoutes(os, deps),
    events: createEventRoutes(os, deps, views),
    system: createSystemRoutes(os, deps),
    oauth: createOAuthRoutes(os, deps),
    tokens: createTokenRoutes(os, deps),
  });
}
