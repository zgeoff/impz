import { createApiAudit } from './audit/api-audit';
import type { SecretFiles } from './broker/secret-files';
import type { ImpdStorage } from './build-impd-storage';
import { createCheckpointService } from './checkpoints/checkpoint-service';
import type { Config } from './config';
import type { EgressService } from './egress/egress-service';
import { createTemplateService } from './images/template-service';
import type { ImpdDeps } from './impd-deps';
import type { Imps } from './imps/imp-service';
import { createNetworkService } from './networks/network-service';
import { printLog } from './process/print-log';
import { createStorageGc } from './storage/storage-gc';

// The services over the imps that the API serves
export function buildImpdServices(
  config: Config,
  deps: Readonly<ImpdDeps>,
  parts: Readonly<{
    storage: Pick<ImpdStorage, 'storageGate' | 'diskBudget'>;
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

export type ImpdServices = Readonly<ReturnType<typeof buildImpdServices>>;
