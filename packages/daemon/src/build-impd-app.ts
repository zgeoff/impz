import type { ImpdServices } from './build-impd-services';
import type { ImpdStorage } from './build-impd-storage';
import type { Config } from './config';
import type { TailscaleStatus } from './host-net/net/tailscale-status';
import type { ImpdDeps } from './impd-deps';
import { BUILD_KEEPALIVE_MS } from './imps/images/build-event-stream';
import type { Imps } from './imps/imps/imp-service';
import type { ImpdAccess } from './load-impd-access';
import type { Broker } from './network/broker/broker-service';
import type { EgressService } from './network/egress/egress-service';
import { printLog } from './platform/process/print-log';
import { buildApp } from './surface/build-app';
import type { AppDeps } from './surface/build-app';
import { createBuildContextRoute } from './surface/images/build-context-route';
import { UNKNOWN_VERSION } from './vm/sleep/vm-identity';
import type { HostIdentity } from './vm/sleep/vm-identity';

export interface ImpdAppParts {
  readonly storage: Pick<ImpdStorage, 'images' | 'diskBudget'>;
  readonly access: ImpdAccess;
  readonly services: ImpdServices;
  readonly imps: Imps;
  readonly governor: AppDeps['governor'];
  readonly broker: Broker;
  readonly egress: EgressService;
  readonly identity: HostIdentity;
  readonly peers: AppDeps['peers'];
  readonly tailnet: AppDeps['tailnet'];
  readonly backups: AppDeps['backups'];
  readonly moves: AppDeps['moves'];
  readonly publicRecords: AppDeps['publicRecords'];
  readonly checkDnsToken: AppDeps['checkDnsToken'];
  readonly readTailscale: () => Promise<TailscaleStatus>;
  readonly readTailnetNames: AppDeps['readTailnetNames'];
  readonly isReady: () => boolean;

  // the gap between the progress events of a streamed image call
  readonly keepaliveMs?: number;
  readonly readKsmHostStats?: AppDeps['readKsmHostStats'];
}

// impd's HTTP app: the RPC API, exec, tunnels, the dashboard and MCP
export function buildImpdApp(
  config: Config,
  deps: Readonly<ImpdDeps>,
  parts: Readonly<ImpdAppParts>,
) {
  const now = deps.now ?? Date.now;
  const keepaliveMs = parts.keepaliveMs ?? BUILD_KEEPALIVE_MS;

  return buildApp({
    config,
    db: deps.db,
    rootToken: deps.rootToken,
    tokens: parts.access.tokens,
    revocations: parts.access.revocations,
    oauth: parts.access.oauth,
    peers: parts.peers,
    tailnet: parts.tailnet,
    imps: parts.imps,
    images: parts.storage.images,
    governor: parts.governor,
    ...(parts.readKsmHostStats !== undefined && { readKsmHostStats: parts.readKsmHostStats }),
    checkpoints: parts.services.checkpoints,
    templates: parts.services.templates,
    backups: parts.backups,
    broker: parts.broker,
    egress: parts.egress,
    networks: parts.services.networks,
    firecrackerVersion:
      parts.identity.firecrackerVersion === UNKNOWN_VERSION
        ? null
        : parts.identity.firecrackerVersion,
    systemFiles: deps.systemFiles.info,
    storage: deps.storage,
    diskBudget: parts.storage.diskBudget,
    gc: parts.services.gc,
    readTailscale: parts.readTailscale,
    readTailnetNames: parts.readTailnetNames,
    publicRecords: parts.publicRecords,
    checkDnsToken: parts.checkDnsToken,
    isReady: parts.isReady,
    now,
    log: deps.log ?? printLog,
    ...(deps.logRpcFailure !== undefined && { logRpcFailure: deps.logRpcFailure }),
    audit: parts.services.audit,
    buildContexts: createBuildContextRoute({
      config,
      images: parts.storage.images,
      diskBudget: parts.storage.diskBudget,
      audit: parts.services.audit,
      now,
      keepaliveMs,
      ...(deps.keepaliveRepeat !== undefined && { repeat: deps.keepaliveRepeat }),
    }),
    imageKeepaliveMs: keepaliveMs,
    ...(deps.keepaliveRepeat !== undefined && { imageKeepaliveRepeat: deps.keepaliveRepeat }),
    moves: parts.moves,
  });
}
