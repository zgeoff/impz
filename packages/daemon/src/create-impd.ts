import { release } from 'node:os';
import { join } from 'node:path';
import packageJson from '../package.json' with { type: 'json' };
import type { Config } from './config';
import { createImpdApp } from './create-impd-app';
import { createImpdFirewall } from './create-impd-firewall';
import { createImpdImps } from './create-impd-imps';
import { createImpdMoves } from './create-impd-moves';
import { createImpdServices } from './create-impd-services';
import { createImpdStorage } from './create-impd-storage';
import type { ImpdStorage } from './create-impd-storage';
import { createTailnetAccess } from './create-tailnet-access';
import { readTailscaleStatus } from './host-net/net/tailscale-status';
import { loadOrCreateToken } from './identity/token';
import { createBackupService } from './imp-ops/backup/backup-service';
import { createIdleLoop } from './imp-ops/idle/idle-loop';
import type { ImpdBoundaries, ImpdDeps } from './impd-deps';
import type { ImpdStartupStep, RunImpdStartupStep } from './impd-startup-steps';
import { createBuilders } from './imps/images/builder-imps';
import { readSetfcapWarning } from './imps/images/unpack-export';
import { createKernelOopsWatch } from './imps/imps/kernel-oops-watch';
import { removeUnusedDrives } from './imps/imps/remove-unused-drives';
import { createAuthorizedKeys } from './imps/ssh/authorized-keys';
import { loadImpdAccess } from './load-impd-access';
import { createSecretFiles } from './network/broker/secret-files';
import { createDnsToken } from './network/https/dns/dns-token';
import { createPublicRecordsLink } from './network/https/public-records-link';
import { createForwardedPeers } from './network/proxy/forwarded-peers';
import type { WakeProxy } from './network/proxy/wake-proxy';
import type { TailnetNames } from './network/tailnet-names/tailnet-names';
import { wireTailnetNames } from './network/tailnet-names/wire-tailnet-names';
import { isImpSetWrite } from './platform/db/is-imp-set-write';
import { openDatabase } from './platform/db/open-database';
import { getErrorMessage } from './platform/process/get-error-message';
import { getImpdLogger } from './platform/process/get-impd-logger';
import { printLog } from './platform/process/print-log';
import { startOtlpExport } from './platform/telemetry/start-otlp-export';
import { startImpdListeners } from './start-impd-listeners';
import { startImpdTickers } from './start-impd-tickers';
import { stopImpd } from './stop-impd';
import type { ImpdStopOptions, ImpdStopParts, ImpdStopStep } from './stop-impd';
import { setupSshDir } from './surface/ssh/host-key';
import { createStorageBackend } from './vm/storage/create-storage-backend';
import { createDataDirs } from './vm/storage/data-layout';
import { CHANGES_USAGE } from './vm/storage/disk-usage-cache';
import { readLiveStorage } from './vm/storage/read-live-storage';
import { setupSystemFiles } from './vm/storage/setup-system-files';
import { checkKsmHost, readKsmHostStats } from './vm/vmm/ksm';

export async function createImpd(config: Config, boundaries: Readonly<ImpdBoundaries> = {}) {
  const plan: ImpdStopParts = { log: boundaries.log ?? printLog };

  try {
    return await startImpdParts(config, boundaries, plan);
  } catch (error) {
    await stopImpd(plan, { sleepImps: false });

    throw error;
  }
}

export type Impd = Awaited<ReturnType<typeof createImpd>>;

async function startImpdParts(
  config: Config,
  boundaries: Readonly<ImpdBoundaries>,
  plan: ImpdStopParts,
) {
  const log = boundaries.log ?? printLog;
  const now = boundaries.now ?? Date.now;
  const startup: ImpdStartupStep[] = [];

  const runStep: RunImpdStartupStep = (step, task) => {
    startup.push(step);

    return task();
  };

  for (const warning of config.warnings) {
    log(`impd: warning: ${warning}`);
  }

  const readKsmStats = boundaries.readKsmHostStats ?? readKsmHostStats;

  runStep('ksm', () => {
    if (config.ksm === null) {
      return;
    }

    const ksm = readKsmStats();
    const refusal = checkKsmHost(boundaries.hostKernelRelease ?? release(), ksm);

    if (refusal !== null) {
      throw new Error(refusal);
    }

    if (ksm?.running === false) {
      log('impd: IMP_KSM is on, but ksmd does not run (/sys/kernel/mm/ksm/run is 0)');
    }
  });

  // OpenTelemetry leaves a meter taken before the export starts a no-op
  const stopTelemetry = await runStep('telemetry', () =>
    startOtlpExport(process.env, packageJson.version),
  );

  plan.stopTelemetry = stopTelemetry;

  const systemFiles = await runStep('data-dir', async () => {
    createDataDirs(config.dataDir);

    const files = await (boundaries.systemFiles ?? setupSystemFiles(config));

    const setfcapWarning = readSetfcapWarning(boundaries.readProcStatus?.());

    if (setfcapWarning !== null) {
      log(setfcapWarning);
    }

    return files;
  });

  const db = await runStep(
    'database',
    () => boundaries.db ?? openDatabase(join(config.dataDir, 'db', 'imp.sqlite')),
  );

  plan.db = boundaries.db === undefined ? db : null;

  const kernelOops = boundaries.imps?.kernelOops ?? createKernelOopsWatch();

  const storage =
    boundaries.storage ??
    createStorageBackend(config, { zfs: { isKernelOopsed: kernelOops.isOopsed } });

  const deps: ImpdDeps = {
    ...boundaries,
    db,
    rootToken: boundaries.rootToken ?? loadOrCreateToken(config.dataDir),
    storage,
    systemFiles,
    imps: { ...boundaries.imps, kernelOops },
  };

  // on ZFS this mounts the disks, so it runs before any VM is re-adopted or woken
  await runStep('storage', async () => {
    const live = await readLiveStorage(db);

    await storage.start(live);
  });

  plan.storage = storage;

  const stored = createImpdStorage(config, deps);
  const diskUsage = stored.diskUsage;

  plan.diskUsage = diskUsage;

  const secretFiles = createSecretFiles(config.dataDir);

  const firewall = await runStep('firewall', () =>
    createImpdFirewall(config, deps, secretFiles, plan),
  );

  const broker = firewall.broker;
  const egress = firewall.egress;
  const proxyHolder: { proxy: WakeProxy | null } = { proxy: null };
  const publicRecords = createPublicRecordsLink();
  const dnsTokenSource = config.https?.dns.token ?? null;
  const dnsToken = dnsTokenSource === null ? null : createDnsToken(dnsTokenSource, now);
  const namesHolder: { names: TailnetNames | null } = { names: null };
  const readTailscale = deps.readTailscale ?? (() => readTailscaleStatus(config.tailscaleEnabled));

  const governed = runStep('imps', () =>
    createImpdImps(config, deps, {
      storage: stored,
      broker,
      egress,
      ipv6: firewall.ipv6,
      readServiceUrl: (name) => namesHolder.names?.readUrl(name) ?? null,
      readTailscale,
    }),
  );

  const imps = governed.imps;
  const governor = governed.governor;
  const identity = governed.identity;

  plan.imps = imps;

  const writeWork = new Set<Promise<unknown>>();

  const runWriteWork = async (work: Promise<unknown> | undefined): Promise<void> => {
    if (work === undefined) {
      return;
    }

    writeWork.add(work);

    try {
      await work;
    } finally {
      writeWork.delete(work);
    }
  };

  const unsubscribeWrites = db.writes.subscribe((write) => {
    if (write.kind !== 'changed' || CHANGES_USAGE.has(write.reason)) {
      diskUsage.requestRefresh();
    }

    if (isImpSetWrite(write)) {
      void runWriteWork(proxyHolder.proxy?.syncListeners());
      void runWriteWork(broker.applyGrants());
      void runWriteWork(namesHolder.names?.runSync());
    }
  });

  const dbWrites = {
    stop: async (): Promise<void> => {
      unsubscribeWrites();

      await Promise.allSettled(writeWork);
    },
  };

  plan.dbWrites = dbWrites;

  await runStep('reconcile', () => imps.reconcileImps());

  const builders = createBuilders({
    config,
    db,
    imps: { ...imps, ...deps.agent },
    ensureImage: stored.images.ensureBuilderImage,
    log,
    testRegistry: firewall.testRegistry,
  });

  stored.setBuilders(builders);

  await runStep('builders', () => builders.removeLeftovers());

  // stale templates go first, so the drive sweep can remove their drives
  runStep('boot-templates', () => {
    for (const key of imps.bootTemplates?.removeStale() ?? []) {
      log(`impd: removed boot template ${key.slice(0, 12)}: this host boots something else`);
    }
  });

  // runs before anything can boot or sleep an imp, so the set of drives in use holds still
  await runStep('system-drives', async () => {
    const removed = await removeUnusedDrives(db, {
      dataDir: config.dataDir,
      findPaths: storage.resolveImpPaths,
      currentDrivePath: systemFiles.systemDrivePath,
      templateDrivePaths: imps.bootTemplates?.listDrivePaths() ?? [],
    });

    for (const name of removed) {
      log(`impd: removed system drive ${name}: no imp uses it`);
    }
  });

  const services = createImpdServices(config, deps, {
    storage: stored,
    imps,
    egress,
    secretFiles,
  });

  const state = { ready: false };

  // a key in this file cannot be bound to a token, so the SSH gateway and the token store
  // share one reader
  const authorizedKeys = createAuthorizedKeys(
    join(setupSshDir(config.dataDir), 'authorized_keys'),
    log,
  );

  const access = await runStep('access', () =>
    loadImpdAccess(config, deps, authorizedKeys.probeListed),
  );

  const backups =
    config.backup === null
      ? null
      : createBackupService({
          dataDir: config.dataDir,
          backup: config.backup,
          db,
          imps,
          storage,
          images: stored.images,
          grants: broker,
          tokens: access.tokens,
          networks: services.networks,
          storageGate: stored.storageGate,
          diskBudget: stored.diskBudget,
        });

  const peers = createForwardedPeers(now);

  const tailnetNames =
    config.tailnetNames === null
      ? null
      : wireTailnetNames({
          names: config.tailnetNames,
          config,
          db,
          imps,
          readTailscale,
          log,
          runCommand: deps.runCommand,
        });

  namesHolder.names = tailnetNames;

  const moves = createImpdMoves(
    config,
    deps,
    {
      storage: stored,
      imps,
      broker,
      egress,
      audit: services.audit,
      readIdentity: () => identity,
    },
    {
      readTailnetIp: async () => {
        const status = await readTailscale();

        return status.ip;
      },
      releaseName: async () => {
        await tailnetNames?.runSync();
      },
      onCommitted: () => {
        diskUsage.requestRefresh();
        void tailnetNames?.runSync();
      },
    },
  );

  await runStep('moves', () => moves.recover());

  const api = createImpdApp(config, deps, {
    storage: stored,
    access,
    services,
    imps: { ...imps, ...deps.agent },
    governor,
    broker,
    egress,
    identity,
    peers,
    tailnet: createTailnetAccess(config, deps, readTailscale),
    backups,
    moves,
    publicRecords,
    checkDnsToken: dnsToken?.check ?? null,
    readTailscale,
    readTailnetNames: tailnetNames === null ? null : tailnetNames.readStatus,
    isReady: () => state.ready,
    readKsmHostStats: readKsmStats,
    ...(deps.keepaliveMs !== undefined && { keepaliveMs: deps.keepaliveMs }),
  });

  plan.closeExecSessions = api.closeExecSessions;

  const listeners = await startImpdListeners(
    config,
    deps,
    {
      api,
      access,
      imps,
      peers,
      broker,
      audit: services.audit,
      authorizedKeys,
      publicRecords,
      dnsToken,
      readTailscale,
      tailnetNames,
      proxyHolder,
    },
    { runStep, plan },
  );

  const idle = createIdleLoop({ config, db, imps, log });

  const tickers = runStep('tickers', () =>
    startImpdTickers(
      config,
      {
        idle,
        oauth: access.oauth,
        governor,
        imps,
        memory: governed.memory,
        proxy: listeners.proxy,
        tailnetNames,
        broker,
        gc: services.gc,
        diskUsage,
        backups,
      },
      { log, ...(deps.tickerTimer !== undefined && { timer: deps.tickerTimer }) },
    ),
  );

  plan.tickers = tickers;

  const printSeedFailure = (error: unknown): void => {
    if (boundaries.log === undefined) {
      getImpdLogger('image').error('could not add the default image: {error}', { error });
    } else {
      log(`impd: could not add the default image: ${getErrorMessage(error)}`);
    }
  };

  const ready = runStep('default-image', async () => {
    await setupDefaultImage(config, stored.images, { log, printSeedFailure });

    state.ready = true;
  });

  return {
    ...stored,
    ...access,
    ...services,
    ...listeners,
    db,
    rootToken: deps.rootToken,
    storage,
    systemFiles,
    governed,
    imps,
    governor,
    broker,
    egress,
    builders,
    backups,
    authorizedKeys,
    peers,
    tailnetNames,
    moves,
    api,
    idle,
    publicRecords,
    dnsToken,
    readTailscale,
    identity,
    state,
    startup,
    ready,
    stop: (options: Readonly<ImpdStopOptions>): Promise<readonly ImpdStopStep[]> =>
      stopImpd(plan, options),
  };
}

async function setupDefaultImage(
  config: Config,
  images: Readonly<ImpdStorage['images']>,
  output: Readonly<{
    log: (message: string) => void;
    printSeedFailure: (error: unknown) => void;
  }>,
): Promise<void> {
  try {
    await images.seedDefaultImage();

    const existing = await images.listImages();

    if (!existing.some((image) => image.name === config.defaultImage)) {
      output.log(
        `impd: warning: no image named ${config.defaultImage} (IMP_DEFAULT_IMAGE); impz new uses ubuntu until \`impz image add <ref> --name ${config.defaultImage}\` adds it`,
      );
    }
  } catch (error) {
    output.printSeedFailure(error);
  }
}
