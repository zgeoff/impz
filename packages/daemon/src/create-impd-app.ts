import { readFileSync } from 'node:fs';
import { release } from 'node:os';
import type { Config } from './config';
import type { ImpdServices } from './create-impd-services';
import type { ImpdStorage } from './create-impd-storage';
import type { TailscaleStatus } from './host-net/net/tailscale-status';
import type { ImpdDeps } from './impd-deps';
import { BUILD_KEEPALIVE_MS } from './imps/images/build/image-op-stream';
import type { Imps } from './imps/imps/imp-service';
import type { ImpdAccess } from './load-impd-access';
import type { Broker } from './network/broker/broker-service';
import type { EgressService } from './network/egress/egress-service';
import { createExposureService } from './network/https/exposure-service';
import { writeDatabaseCopy } from './platform/db/database-copy';
import { startRealTimer } from './platform/process/start-real-timer';
import { createApp } from './surface/create-app';
import type { AppDeps } from './surface/create-app';
import { createBuildContextRoute } from './surface/images/build-context-route';
import { readHostInfo } from './surface/read-host-info';
import { UNKNOWN_VERSION } from './vm/sleep/vm-identity';
import type { HostIdentity } from './vm/sleep/vm-identity';
import { readHugePagePool } from './vm/vmm/read-huge-page-pool';

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
  readonly keepaliveMs?: number;
  readonly readKsmHostStats?: AppDeps['readKsmHostStats'];
}

export function createImpdApp(
  config: Config,
  deps: Readonly<ImpdDeps>,
  parts: Readonly<ImpdAppParts>,
) {
  const now = deps.now ?? Date.now;
  const keepaliveMs = parts.keepaliveMs ?? BUILD_KEEPALIVE_MS;

  return createApp({
    config,
    exposure: createExposureService({
      db: deps.db,
      https: config.https,
      updateRecords: parts.publicRecords.update,
    }),
    writeDatabaseCopy: (name) =>
      writeDatabaseCopy(deps.db, {
        diskBudget: parts.storage.diskBudget,
        dataDir: config.dataDir,
        name,
        now,
      }),
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
    ...(deps.logRpcFailure !== undefined && { logRpcFailure: deps.logRpcFailure }),
    audit: parts.services.audit,
    buildContexts: createBuildContextRoute({
      config,
      images: parts.storage.images,
      diskBudget: parts.storage.diskBudget,
      audit: parts.services.audit,
      now,
      startTimer:
        deps.buildUploadTimer ??
        ((fire, durationMs) => startRealTimer(fire, durationMs, { isUnref: true })),
    }),
    imageKeepaliveMs: keepaliveMs,
    ...(deps.keepaliveRepeat !== undefined && { imageKeepaliveRepeat: deps.keepaliveRepeat }),
    moves: parts.moves,
    readHostInfo: () =>
      readHostInfo({
        isHugePages: config.hugePages !== null,
        readKernel: () => deps.hostKernelRelease ?? release(),
        readCpuInfo: deps.readCpuInfo ?? (() => readFileSync('/proc/cpuinfo', 'utf8')),
        readHugePagePool: deps.imps?.readHugePagePool ?? (() => readHugePagePool()),
        readBootTemplateCount: parts.imps.bootTemplates?.readReadyCount ?? null,
      }),
  });
}
