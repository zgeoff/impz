import { join } from 'node:path';
import type { TailnetPeer } from './auth/tailnet-identity';
import { createBackupService } from './backup/backup-service';
import { createBroker } from './broker/broker-service';
import type { Broker, BrokerDeps } from './broker/broker-service';
import { createSecretFiles } from './broker/secret-files';
import type { SecretFiles } from './broker/secret-files';
import type { AppDeps } from './build-app';
import { buildImpdApp } from './build-impd-app';
import { buildImpdServices } from './build-impd-services';
import { buildImpdStorage } from './build-impd-storage';
import type { ImpdStorage } from './build-impd-storage';
import { buildTailnetAccess } from './build-tailnet-access';
import type { DiskFreezer } from './checkpoints/consistent-disk';
import type { Config } from './config';
import { createImpdMoves } from './create-impd-moves';
import { countImpsByState } from './db/imps';
import { isImpSetWrite } from './db/is-imp-set-write';
import type { ImpDatabase } from './db/open-database';
import { runNft } from './egress/egress-firewall';
import { createEgressService } from './egress/egress-service';
import type { EgressDeps, EgressService } from './egress/egress-service';
import { createDnsToken } from './https/dns/dns-token';
import { createPublicRecordsLink } from './https/public-records-link';
import type { Repeat } from './images/build-event-stream';
import { createBuilders } from './images/builder-imps';
import type { Builders } from './images/builder-imps';
import { HOST_ADD_WARNING } from './images/create-image-adds';
import { HOST_BUILD_WARNING } from './images/create-image-builds';
import type { ImageServiceDeps } from './images/image-service';
import type { ImpServiceDeps, Imps } from './imps/imp-service';
import { removeUnusedDrives } from './imps/remove-unused-drives';
import { loadImpdAccess } from './load-impd-access';
import {
  checkHostRules6,
  readIpv6DefaultRoute,
  readOrCreateUlaPrefix,
  resolveIpv6Plan,
} from './net/ipv6-plan';
import type { Ipv6Plan } from './net/ipv6-plan';
import { readTailscaleStatus } from './net/tailscale-status';
import type { TailscaleStatus } from './net/tailscale-status';
import type { TapDevices } from './net/tap-devices';
import { printLog } from './process/print-log';
import { runCommand } from './process/run-command';
import type { CommandRunner } from './process/run-command';
import { createForwardedPeers } from './proxy/forwarded-peers';
import type { WakeProxy } from './proxy/wake-proxy';
import { readHostIdentity } from './sleep/vm-identity';
import type { HostIdentity } from './sleep/vm-identity';
import { createAuthorizedKeys } from './ssh/authorized-keys';
import { setupSshDir } from './ssh/host-key';
import { startGovernedImps } from './start-governed-imps';
import { CHANGES_USAGE } from './storage/disk-usage-cache';
import { readLiveStorage } from './storage/read-live-storage';
import type { SystemFiles } from './storage/setup-system-files';
import type { StorageBackend } from './storage/storage-backend';
import { buildTailnetNames } from './tailnet-names/build-tailnet-names';
import type { TailnetNames } from './tailnet-names/tailnet-names';
import { startImpTelemetry } from './telemetry/imp-telemetry';
import { createCpuCgroups } from './vmm/cpu-cgroups';
import type { CpuCgroups } from './vmm/cpu-cgroups';
import { createJails } from './vmm/jail';
import { createVmRunner } from './vmm/vm-runner';
import type { VmRunner } from './vmm/vm-runner';

// The broker's reach past impd: the guest's CA install, the token endpoint,
// the upstreams and the tunnels' DNS and dials
type BrokerBoundaries = Pick<
  BrokerDeps,
  | 'installBundle'
  | 'fetch'
  | 'oauthFetch'
  | 'now'
  | 'runOAuthTimer'
  | 'resolveTunnelTarget'
  | 'dialTunnel'
  | 'afterRuleRead'
  | 'beforeGrantWrite'
>;

// The firewall's reach past impd: nft, conntrack, iptables, the routes and
// the upstream DNS
type EgressBoundaries = Pick<
  EgressDeps,
  | 'runNft'
  | 'readConnected6'
  | 'readConnected4'
  | 'readUplinks'
  | 'flushConnections'
  | 'flushPair'
  | 'readForwardRules'
  | 'forward'
  | 'resolveExact'
  | 'now'
  | 'repeat'
>;

// The imp service's reach past impd: /proc, KSM, the host's filesystem
// grow, the host's cores, the memory limit and the agent's session taps
type ImpBoundaries = Pick<
  ImpServiceDeps,
  | 'readRamMib'
  | 'readRssMib'
  | 'readUnsharedRamMib'
  | 'checkGuestMerge'
  | 'readKsmProfitMib'
  | 'growFilesystem'
  | 'hostCpus'
  | 'memoryLimit'
  | 'now'
  | 'sleep'
  | 'sleepTiming'
  | 'openTap'
  | 'kernelOops'
  | 'readThreadIds'
>;

// What impd reaches outside its own code: every field but the four
// required ones defaults to the host's real one, which main.ts uses. A test
// passes stand-ins only for what it cannot host.
export interface ImpdDeps {
  readonly db: ImpDatabase;

  // the token in <dataDir>/token
  readonly rootToken: string;

  // the backend over the data dir, not started (createStorageBackend)
  readonly storage: StorageBackend;

  // the kernel and system drive in the data dir (setupSystemFiles)
  readonly systemFiles: SystemFiles;

  readonly log?: (message: string) => void;

  // the API's unexpected RPC failures; stderr by default
  readonly logRpcFailure?: AppDeps['logRpcFailure'];

  // leases', the RAM governor's, egress's, the broker's injected and the
  // API services' clock; Date.now by default. project-testing names what
  // still reads Date.now itself
  readonly now?: () => number;

  // the host's free space as the disk budget sees it; the storage's own
  readonly readDiskSpace?: StorageBackend['readUsage'];

  // the host's IPv6 routes and rules, read into a plan for imps
  readonly resolveIpv6?: () => Promise<Ipv6Plan | null>;

  // tailscaled's status, and `tailscale whois`
  readonly readTailscale?: () => Promise<TailscaleStatus>;
  readonly whois?: (address: string) => Promise<TailnetPeer | null>;

  // the cgroup tree; /sys/fs/cgroup by default
  readonly cgroups?: CpuCgroups;

  // what this host boots imps with: Firecracker's versions, the CPU, the
  // kernel and the system drive
  readonly readIdentity?: (
    systemFiles: Readonly<SystemFiles>,
    ipv6Prefix: string | null,
  ) => HostIdentity;

  // Firecracker and the jailer; `runCommand` runs the jailer's mount and
  // chown when `vms` is left out
  readonly vms?: VmRunner;
  readonly runCommand?: CommandRunner;

  // `ip` for each imp's tap
  readonly taps?: TapDevices;
  readonly broker?: BrokerBoundaries;
  readonly egress?: EgressBoundaries;
  readonly imps?: ImpBoundaries;

  // the docker engine a host build talks to
  readonly images?: Pick<ImageServiceDeps, 'dockerEnv' | 'builderImagePullMs'>;

  // fsfreeze inside the guest, around a checkpoint or a template's disk
  readonly freezer?: DiskFreezer;

  // the gap between the progress events of a streamed image call;
  // BUILD_KEEPALIVE_MS by default
  readonly keepaliveMs?: number;

  // the timer of those progress events; runOnInterval by default
  readonly keepaliveRepeat?: Repeat;
}

// The credential broker, with the secret files it shares with the GC
export function createImpdBroker(
  config: Config,
  deps: Readonly<ImpdDeps>,
  parts: Readonly<{ ipv6: Ipv6Plan | null; secretFiles: SecretFiles }>,
): Promise<Broker> {
  return createBroker({
    config,
    db: deps.db,
    log: deps.log ?? printLog,
    ipv6: parts.ipv6,
    secretFiles: parts.secretFiles,
    ...(deps.now !== undefined && { now: deps.now }),
    ...deps.broker,
  });
}

// The firewall and its resolver, not started
export function buildImpdEgress(
  config: Config,
  deps: Readonly<ImpdDeps>,
  parts: Readonly<{
    ipv6: Ipv6Plan | null;
    broker: Pick<Broker, 'isGranted' | 'closeTunnels'>;
  }>,
): EgressService {
  return createEgressService({
    config,
    db: deps.db,
    ipv6: parts.ipv6,
    log: deps.log ?? printLog,
    isGranted: parts.broker.isGranted,
    closeTunnels: parts.broker.closeTunnels,
    ...(deps.now !== undefined && { now: deps.now }),
    ...deps.egress,
  });
}

// The image builders, which run as imps
export function startImpdBuilders(
  config: Config,
  deps: Readonly<ImpdDeps>,
  storage: Readonly<ImpdStorage>,
  imps: Readonly<Imps>,
): Builders {
  const builders = createBuilders({
    config,
    db: deps.db,
    imps,
    ensureImage: storage.images.ensureBuilderImage,
    log: deps.log ?? printLog,
  });

  storage.setBuilders(builders);

  return builders;
}

// Every impd service, wired and started as a host runs them: storage
// mounted, the firewall up, the VMs re-adopted and leftovers removed.
// main.ts opens the ports, starts the tickers and owns the stop.
export async function createImpd(config: Config, deps: Readonly<ImpdDeps>) {
  const db = deps.db;
  const storage = deps.storage;
  const systemFiles = deps.systemFiles;
  const log = deps.log ?? printLog;
  const now = deps.now ?? Date.now;

  // before any VM is re-adopted or woken: on ZFS the disks are mounted here
  const live = await readLiveStorage(db);

  await storage.start(live);

  const stored = buildImpdStorage(config, deps);
  const diskUsage = stored.diskUsage;

  if (config.build.isolation === 'host') {
    log(HOST_BUILD_WARNING);
    log(HOST_ADD_WARNING);
  }

  const ipv6 = await (
    deps.resolveIpv6 ??
    (() =>
      resolveIpv6Plan(config.ipv6, {
        readDefaultRoute: readIpv6DefaultRoute,
        readUlaPrefix: () => readOrCreateUlaPrefix(join(config.dataDir, 'net', 'ipv6-ula')),
        checkHostRules: () => checkHostRules6(),
        runNft: deps.egress?.runNft ?? runNft,
        log,
      }))
  )();

  // the broker's and the GC's: the GC lists and removes what the broker kept aside
  const secretFiles = createSecretFiles(config.dataDir);

  const broker = await createImpdBroker(config, deps, { ipv6, secretFiles });

  // the firewall and its resolver, before any VM is adopted, booted or woken
  const egress = buildImpdEgress(config, deps, { ipv6, broker });

  await egress.start();

  const proxyHolder: { proxy: WakeProxy | null } = { proxy: null };
  const publicRecords = createPublicRecordsLink();
  const dnsTokenSource = config.https?.dns.token ?? null;
  const dnsToken = dnsTokenSource === null ? null : createDnsToken(dnsTokenSource, now);
  const namesHolder: { names: TailnetNames | null } = { names: null };
  const readTailscale = deps.readTailscale ?? (() => readTailscaleStatus(config.tailscaleEnabled));
  const cgroups = deps.cgroups ?? createCpuCgroups({ root: '/sys/fs/cgroup', log });

  if (!cgroups.isEnforced) {
    const effect =
      config.jailerBin === null
        ? 'CPU limits are kept, not applied'
        : 'no jailed VM can start (IMP_JAILER=false runs them unjailed, with no limits)';

    log(`impd: no cpu controller under /sys/fs/cgroup/imps; ${effect}`);
  }

  // spawns Firecracker once per version flag; system.info reuses it
  const identity = (
    deps.readIdentity ?? ((files, prefix) => readHostIdentity(config.firecrackerBin, files, prefix))
  )(systemFiles, ipv6?.prefix.text ?? null);

  // even with the jailer off, impd cleans up after jailed VMs it adopted
  const vms =
    deps.vms ??
    createVmRunner(
      createJails({
        jailerBin: config.jailerBin ?? 'jailer',
        firecrackerBin: Bun.which(config.firecrackerBin) ?? config.firecrackerBin,
        chrootBase: config.jailDir,
        run: deps.runCommand ?? runCommand,
        log,
        killCgroup: cgroups.kill,
      }),
      config.ksm?.execBin ?? null,
    );

  const governed = startGovernedImps(
    config,
    deps,
    {
      storage: stored,
      broker,
      egress,
      ipv6,
      cgroups,
      readServiceUrl: (name) => namesHolder.names?.readUrl(name) ?? null,
      readTailscale,
    },
    identity,
    vms,
  );

  const imps = governed.imps;
  const governor = governed.governor;

  startImpTelemetry({
    bus: imps.events,
    subscribeResources: imps.subscribeResources,
    readDiskUsedBytes: diskUsage.readExclusiveTotal,
    readStateCounts: () => countImpsByState(db),
    readRebootReason: imps.readRebootReason,
    readRam: async () => {
      const usage = await governor.readUsage();

      return { usedMib: usage.usedMib, budgetMib: config.ramBudgetMib };
    },
  });

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

  await imps.reconcileImps();

  const builders = startImpdBuilders(config, deps, stored, imps);

  // a build that a stop cut short left its builder
  await builders.removeLeftovers();

  // templates this host no longer boots go first, so their drives can too
  for (const key of imps.bootTemplates?.removeStale() ?? []) {
    log(`impd: removed boot template ${key.slice(0, 12)}: this host boots something else`);
  }

  // before anything can boot or sleep an imp, so the set of drives in use holds
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

  const access = await loadImpdAccess(config, deps, authorizedKeys.isListed);

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

  await moves.recover();

  const api = buildImpdApp(config, deps, {
    storage: stored,
    access,
    services,
    imps,
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
    ...(deps.keepaliveMs !== undefined && { keepaliveMs: deps.keepaliveMs }),
  });

  return {
    ...stored,
    ...access,
    ...services,
    governed,
    imps,
    governor,
    broker,
    egress,
    backups,
    authorizedKeys,
    peers,
    tailnetNames,
    moves,
    api,
    proxyHolder,
    publicRecords,
    dnsToken,
    readTailscale,
    state,
  };
}
