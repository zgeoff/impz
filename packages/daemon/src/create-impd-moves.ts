import type { ApiAudit } from './audit/api-audit';
import type { Config } from './config';
import type { ImpdDeps } from './create-impd';
import type { ImpdStorage } from './create-impd-storage';
import type { EgressService } from './egress/egress-service';
import type { Imps } from './imps/imp-service';
import { createMoveService } from './moves/move-service';
import type { MoveServiceDeps } from './moves/move-service';
import { printLog } from './process/print-log';
import type { HostIdentity } from './sleep/vm-identity';

// The moves to and from other hosts
export function createImpdMoves(
  config: Config,
  deps: Readonly<ImpdDeps>,
  parts: Readonly<{
    storage: Pick<ImpdStorage, 'storageGate' | 'diskBudget'>;
    imps: Imps;
    broker: MoveServiceDeps['grants'];
    egress: EgressService;
    audit: ApiAudit;
    readIdentity: () => HostIdentity;
  }>,
  hooks: Readonly<
    Pick<MoveServiceDeps, 'readTailnetIp' | 'releaseName' | 'onCommitted'> &
      Partial<
        Pick<
          MoveServiceDeps,
          'fetch' | 'startPeerDeadline' | 'partBytes' | 'readWarmHost' | 'readTapMac'
        >
      >
  >,
) {
  return createMoveService({
    audit: parts.audit,
    config,
    db: deps.db,
    dataDir: config.dataDir,
    storage: deps.storage,
    storageGate: parts.storage.storageGate,
    diskBudget: parts.storage.diskBudget,
    imps: parts.imps,
    grants: parts.broker,
    egress: parts.egress,
    readIdentity: parts.readIdentity,
    ...hooks,
    now: deps.now ?? Date.now,
    log: deps.log ?? printLog,
  });
}
