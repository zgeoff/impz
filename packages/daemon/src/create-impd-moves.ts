import type { Config } from './config';
import type { ImpdStorage } from './create-impd-storage';
import { createMoveService } from './imp-ops/moves/move-service';
import type { MoveService, MoveServiceDeps } from './imp-ops/moves/move-service';
import type { PeerDeps } from './imp-ops/moves/send-to-peer';
import type { ImpdDeps } from './impd-deps';
import type { Imps } from './imps/imps/imp-service';
import type { EgressService } from './network/egress/egress-service';
import type { ApiAudit } from './platform/audit/api-audit';
import { createMovePeerHandler } from './surface/moves/create-move-peer-handler';
import type { MovePeerHandler } from './surface/moves/create-move-peer-handler';
import { makeConnectMovePeer } from './surface/moves/make-connect-move-peer';
import type { HostIdentity } from './vm/sleep/vm-identity';
import { writeImageFiles } from './vm/storage/write-image-files';

// a caller's commit hook hears each commit after impd's own hook, never in its place
export type ImpdMoveBoundaries = Partial<
  Pick<MoveServiceDeps, 'partBytes' | 'readWarmHost' | 'readTapMac' | 'onCommitted'>
> &
  PeerDeps;

export type ImpdMoves = MoveService & MovePeerHandler;

export function createImpdMoves(
  config: Config,
  deps: Readonly<ImpdDeps>,
  parts: Readonly<{
    storage: Pick<ImpdStorage, 'storageGate' | 'diskBudget' | 'images'>;
    imps: Imps;
    broker: MoveServiceDeps['grants'];
    egress: EgressService;
    audit: ApiAudit;
    readIdentity: () => HostIdentity;
  }>,
  hooks: Readonly<Pick<MoveServiceDeps, 'readTailnetIp' | 'releaseName' | 'onCommitted'>>,
): ImpdMoves {
  const now = deps.now ?? Date.now;
  const { fetch, startPeerDeadline, ...boundaries } = deps.moves ?? {};

  const peerDeps: PeerDeps = {
    ...(fetch !== undefined && { fetch }),
    ...(startPeerDeadline !== undefined && { startPeerDeadline }),
  };

  const service = createMoveService({
    config,
    db: deps.db,
    dataDir: config.dataDir,
    storage: deps.storage,
    storageGate: parts.storage.storageGate,
    diskBudget: parts.storage.diskBudget,
    images: parts.storage.images,
    imps: parts.imps,
    grants: parts.broker,
    egress: parts.egress,
    readIdentity: parts.readIdentity,
    writeImageFiles,
    ...hooks,
    ...boundaries,
    ...peerDeps,
    connectPeer: makeConnectMovePeer(peerDeps),
    onCommitted: (name) => {
      hooks.onCommitted(name);
      deps.moves?.onCommitted?.(name);
    },
    now,
  });

  const handler = createMovePeerHandler({ calls: service.peerCalls, audit: parts.audit, now });

  return { ...service, respond: handler.respond };
}
