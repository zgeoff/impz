import type { ImpdStorage } from './build-impd-storage';
import type { Config } from './config';
import { createMoveService } from './imp-ops/moves/move-service';
import type { MoveServiceDeps } from './imp-ops/moves/move-service';
import type { ImpdDeps } from './impd-deps';
import type { Imps } from './imps/imps/imp-service';
import type { EgressService } from './network/egress/egress-service';
import type { ApiAudit } from './platform/audit/api-audit';
import { printLog } from './platform/process/print-log';
import type { HostIdentity } from './vm/sleep/vm-identity';

// A move's reach past impd: the other host, the deadline on each request to
// it, the part size, the warm facts and the source's taps
// onCommitted hears each commit after impd's own hook, never in its place
export type ImpdMoveBoundaries = Partial<
  Pick<
    MoveServiceDeps,
    'fetch' | 'startPeerDeadline' | 'partBytes' | 'readWarmHost' | 'readTapMac' | 'onCommitted'
  >
>;

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
  hooks: Readonly<Pick<MoveServiceDeps, 'readTailnetIp' | 'releaseName' | 'onCommitted'>>,
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
    ...deps.moves,
    onCommitted: (name) => {
      hooks.onCommitted(name);
      deps.moves?.onCommitted?.(name);
    },
    now: deps.now ?? Date.now,
    log: deps.log ?? printLog,
  });
}
