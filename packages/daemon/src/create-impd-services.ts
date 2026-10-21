import type { Config } from './config';
import type { ImpdStorage } from './create-impd-storage';
import { createCheckpointService } from './imp-ops/checkpoints/checkpoint-service';
import type { ImpdDeps } from './impd-deps';
import { createTemplateService } from './imps/images/template-service';
import type { Imps } from './imps/imps/imp-service';
import type { SecretFiles } from './network/broker/secret-files';
import type { EgressService } from './network/egress/egress-service';
import { createNetworkService } from './network/networks/network-service';
import { createApiAudit } from './platform/audit/api-audit';
import { printLog } from './platform/process/print-log';
import { createStorageGc } from './vm/storage/storage-gc';

export function createImpdServices(
  config: Config,
  deps: Readonly<ImpdDeps>,
  parts: Readonly<{
    storage: Pick<ImpdStorage, 'storageGate' | 'diskBudget' | 'images'>;
    imps: Imps;
    egress: EgressService;
    secretFiles: SecretFiles;
  }>,
) {
  const db = deps.db;
  const log = deps.log ?? printLog;
  const storage = deps.storage;
  const freezer = deps.freezer === undefined ? {} : { freezer: deps.freezer };

  const checkpoints = createCheckpointService({
    config,
    db,
    imps: parts.imps,
    storage,
    diskBudget: parts.storage.diskBudget,
    log,
    ...freezer,
  });

  const templates = createTemplateService({
    config,
    db,
    imps: parts.imps,
    storage,
    storageGate: parts.storage.storageGate,
    diskBudget: parts.storage.diskBudget,
    runImageEviction: parts.storage.images.runImageEviction,
    now: deps.now ?? Date.now,
    log,
    ...freezer,
  });

  const networks = createNetworkService({ db, egress: parts.egress, imps: parts.imps });

  const gc = createStorageGc({
    db,
    storage,
    storageGate: parts.storage.storageGate,
    log,
    secretFiles: parts.secretFiles,
  });

  const audit = createApiAudit({ db, now: deps.now ?? Date.now, log });

  return { checkpoints, templates, networks, gc, audit };
}

export type ImpdServices = Readonly<ReturnType<typeof createImpdServices>>;
