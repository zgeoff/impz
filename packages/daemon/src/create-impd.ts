import { release } from 'node:os';
import { join } from 'node:path';
import packageJson from '../package.json' with { type: 'json' };
import { createBackupService } from './backup/backup-service';
import { createSecretFiles } from './broker/secret-files';
import { buildImpdApp } from './build-impd-app';
import { buildImpdServices } from './build-impd-services';
import { buildImpdStorage } from './build-impd-storage';
import type { ImpdStorage } from './build-impd-storage';
import { buildTailnetAccess } from './build-tailnet-access';
import type { Config } from './config';
import { createImpdFirewall } from './create-impd-firewall';
import { createImpdImps } from './create-impd-imps';
import { createImpdMoves } from './create-impd-moves';
import { isImpSetWrite } from './db/is-imp-set-write';
import { openDatabase } from './db/open-database';
import { createDnsToken } from './https/dns/dns-token';
import { createPublicRecordsLink } from './https/public-records-link';
import { createIdleLoop } from './idle/idle-loop';
import { createBuilders } from './images/builder-imps';
import { HOST_ADD_WARNING } from './images/create-image-adds';
import { HOST_BUILD_WARNING } from './images/create-image-builds';
import { readSetfcapWarning } from './images/unpack-export';
import type { ImpdBoundaries, ImpdDeps } from './impd-deps';
import type { ImpdStartupStep, RunImpdStartupStep } from './impd-startup-steps';
import { createKernelOopsWatch } from './imps/kernel-oops-watch';
import { removeUnusedDrives } from './imps/remove-unused-drives';
import { loadImpdAccess } from './load-impd-access';
import { readTailscaleStatus } from './net/tailscale-status';
import { getImpdLogger } from './process/get-impd-logger';
import { printLog } from './process/print-log';
import { createForwardedPeers } from './proxy/forwarded-peers';
import type { WakeProxy } from './proxy/wake-proxy';
import { createAuthorizedKeys } from './ssh/authorized-keys';
import { setupSshDir } from './ssh/host-key';
import { startImpdListeners } from './start-impd-listeners';
import { startImpdTickers } from './start-impd-tickers';
import { stopImpd } from './stop-impd';
import type { ImpdStopOptions, ImpdStopStep } from './stop-impd';
import { createStorageBackend } from './storage/create-storage-backend';
import { createDataDirs } from './storage/data-layout';
import { CHANGES_USAGE } from './storage/disk-usage-cache';
import { readLiveStorage } from './storage/read-live-storage';
import { setupSystemFiles } from './storage/setup-system-files';
import { buildTailnetNames } from './tailnet-names/build-tailnet-names';
import type { TailnetNames } from './tailnet-names/tailnet-names';
import { startOtlpExport } from './telemetry/start-otlp-export';
import { loadOrCreateToken } from './token';
import { checkKsmHost, readKsmHostStats } from './vmm/ksm';

// impd as a host runs it: each of IMPD_STARTUP_STEPS in order, recorded in
// `startup`, from the data dir to the tickers. main.ts loads the config and
// wires the signals to `stop`.
export async function createImpd(config: Config, boundaries: Readonly<ImpdBoundaries> = {}) {
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

  // before any instrument is made: a meter taken earlier stays a no-op
  const stopTelemetry = await runStep('telemetry', () =>
    startOtlpExport(process.env, packageJson.version),
  );

  const systemFiles = await runStep('data-dir', async () => {
    createDataDirs(config.dataDir);

    const files = await (boundaries.systemFiles ?? setupSystemFiles(config));

    // a start-time hint; an image with a file capability still fails its build
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

  // one watch of the taint flag: the imps' hold and storage's reclaim log
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

  // before any VM is re-adopted or woken: on ZFS the disks are mounted here
  await runStep('storage', async () => {
    const live = await readLiveStorage(db);

    await storage.start(live);
  });

  const stored = buildImpdStorage(config, deps);
  const diskUsage = stored.diskUsage;

  if (config.build.isolation === 'host') {
    log(HOST_BUILD_WARNING);
    log(HOST_ADD_WARNING);
  }

  // the broker's and the GC's: the GC lists and removes what the broker kept aside
  const secretFiles = createSecretFiles(config.dataDir);

  const firewall = await runStep('firewall', () => createImpdFirewall(config, deps, secretFiles));

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

  // an imp that comes or goes opens or closes its proxy port and its grants
  db.writes.subscribe((write) => {
    // storage comes or goes with an imp or a checkpoint, and changes when
    // its disk grows or a stop or sleep writes it out
    if (write.kind !== 'changed' || CHANGES_USAGE.has(write.reason)) {
      diskUsage.requestRefresh();
    }

    if (isImpSetWrite(write)) {
      void proxyHolder.proxy?.syncListeners();
      void broker.applyGrants();
      void namesHolder.names?.runSync();
    }
  });

  await runStep('reconcile', () => imps.reconcileImps());

  // the image builders, which run as imps
  const builders = createBuilders({
    config,
    db,
    imps,
    ensureImage: stored.images.ensureBuilderImage,
    log,
  });

  stored.setBuilders(builders);

  // a build that a stop cut short left its builder
  await runStep('builders', () => builders.removeLeftovers());

  // templates this host no longer boots go first, so their drives can too
  runStep('boot-templates', () => {
    for (const key of imps.bootTemplates?.removeStale() ?? []) {
      log(`impd: removed boot template ${key.slice(0, 12)}: this host boots something else`);
    }
  });

  // before anything can boot or sleep an imp, so the set of drives in use holds
  await runStep('system-drives', async () => {
    const removed = await removeUnusedDrives(
      db,
      config.dataDir,
      storage.resolveImpPaths,
      systemFiles.systemDrivePath,
      imps.bootTemplates?.listDrivePaths() ?? [],
    );

    for (const name of removed) {
      log(`impd: removed system drive ${name}: no imp uses it`);
    }
  });

  const services = buildImpdServices(config, deps, {
    storage: stored,
    imps,
    egress,
    secretFiles,
  });

  const state = { ready: false };

  // a key in this file cannot be bound to a token, so the gateway and the
  // token store read the same one
  const authorizedKeys = createAuthorizedKeys(
    join(setupSshDir(config.dataDir), 'authorized_keys'),
    log,
  );

  const access = await runStep('access', () =>
    loadImpdAccess(config, deps, authorizedKeys.isListed),
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
      : buildTailnetNames({
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

      // the received disk counts here now; the source's ImpRemoved counts there
      onCommitted: () => {
        diskUsage.requestRefresh();
        void tailnetNames?.runSync();
      },
    },
  );

  await runStep('moves', () => moves.recover());

  const api = buildImpdApp(config, deps, {
    storage: stored,
    access,
    services,
    imps: { ...imps, ...deps.agent },
    governor,
    broker,
    egress,
    identity,
    peers,
    tailnet: buildTailnetAccess(config, deps, readTailscale),
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
    runStep,
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

  // ready either way: a failed seed leaves `impz image add` to the user
  const ready = runStep('default-image', async () => {
    await setupDefaultImage(config, stored.images, log);

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

    // the default image's seed, which impd does not wait for
    ready,

    // takes impd out of service; the process exits after it. A database
    // the caller passed stays open.
    stop: (options: Readonly<ImpdStopOptions>): Promise<readonly ImpdStopStep[]> =>
      stopImpd(
        {
          diskUsage,
          tickers,
          https: listeners.https,
          proxy: listeners.proxy,
          broker,
          egress,
          ssh: listeners.ssh,
          closeExecSessions: api.closeExecSessions,
          publicMcp: listeners.publicMcp,
          api: {
            stop: async (closeActive) => {
              await listeners.app.stop(closeActive);
            },
          },
          imps,
          storage,
          stopTelemetry,
          db: boundaries.db === undefined ? db : null,
          log,
        },
        options,
      ),
  };
}

export type Impd = Awaited<ReturnType<typeof createImpd>>;

// The default image on a first start, and a warning when the configured
// one is missing; a failure is logged, never thrown
async function setupDefaultImage(
  config: Config,
  images: Readonly<ImpdStorage['images']>,
  log: (message: string) => void,
): Promise<void> {
  try {
    await images.seedDefaultImage();

    const existing = await images.listImages();

    if (!existing.some((image) => image.name === config.defaultImage)) {
      log(
        `impd: warning: no image named ${config.defaultImage} (IMP_DEFAULT_IMAGE); impz new uses ubuntu until \`impz image add <ref> --name ${config.defaultImage}\` adds it`,
      );
    }
  } catch (error) {
    getImpdLogger('image').error('could not add the default image: {error}', { error });
  }
}
