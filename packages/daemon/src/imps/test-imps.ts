import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import type { InstallBundle } from '../broker/guest-trust';
import type { OAuthFetch } from '../broker/oauth-refresher';
import { createSecretFiles } from '../broker/secret-files';
import { TunnelRefusedError } from '../broker/tunnel-target';
import { loadConfig } from '../config';
import type { Config } from '../config';
import { createImpdBroker, createImpdEgress, startImpdBuilders } from '../create-impd';
import type { ImpdDeps } from '../create-impd';
import { createImpdStorage } from '../create-impd-storage';
import { createImage } from '../db/images';
import type { ImageRecord } from '../db/images';
import { openDatabase } from '../db/open-database';
import { loadImpdAccess } from '../load-impd-access';
import type { Uplinks } from '../net/host-routes';
import type { Ipv6Plan } from '../net/ipv6-plan';
import { writeSnapshotMeta } from '../sleep/snapshot-meta';
import type { SnapshotIdentity } from '../sleep/snapshot-meta';
import type { HostIdentity } from '../sleep/vm-identity';
import { startGovernedImps } from '../start-governed-imps';
import type { GovernedParts } from '../start-governed-imps';
import { buildSystemDrivePath, buildSystemDrivesDir } from '../storage/data-layout';
import type { ImpPaths } from '../storage/data-layout';
import type { StorageBackend } from '../storage/storage-backend';
import { createXfsBackend } from '../storage/xfs-backend';
import { buildStubVmm } from '../test-utils/build-stub-vmm'; // oxlint-disable-line zgeoff/import-zones -- a test harness outside test-utils/; GEO-363 moves it to @impz/daemon/testing
import { createCpuCgroups } from '../vmm/cpu-cgroups';
import type { CpuCgroups } from '../vmm/cpu-cgroups';
import type { Jails } from '../vmm/jail';
import type { KsmHostStats } from '../vmm/ksm';
import { readThreadIds } from '../vmm/vm-stats';
import { buildTestDeps } from './build-test-deps';
import { NO_KERNEL_OOPS, createKernelOopsWatch } from './kernel-oops-watch';
import { readNoTailscale } from './read-no-tailscale';

// every awake fake VM owns this much, as the governor measures it
const FAKE_VM_RAM_MIB = 300;
const FAKE_VM_RSS_MIB = 340;

// the sha256 of the system drive every test impd starts with
const TEST_DRIVE = 'd1'.repeat(32);

// what a host with `drive` installed in `dataDir` boots imps with
function buildTestIdentity(dataDir: string, drive: string): HostIdentity {
  return {
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: 'test',
    guestKernel: 'k',
    systemDrive: drive,
    systemDrivePath: buildSystemDrivePath(dataDir, drive),
    cpuModel: 'Test CPU',
    cpuFlags: 'test-flags',
  };
}

export interface ImpTestOptions {
  readonly env?: Readonly<Record<string, string>>;

  // a data dir the caller made and removes, such as a mounted dataset; a
  // fresh temp dir that the dispose removes by default
  readonly dataDir?: string;

  // a plain copy by default: the test tmpdir is not XFS
  readonly cloneDisk?: (source: string, target: string) => Promise<void>;

  // the host's grow of a new disk's filesystem, after the harness records it;
  // grown at once by default
  readonly growFilesystem?: (disk: string) => Promise<boolean>;

  // sees each log line as impd writes it
  readonly onLog?: (message: string) => void;

  // the broker's CA install into a guest; by default it records the imp's
  // vsock path and succeeds
  readonly installBundle?: InstallBundle;

  // where the broker's plain tunnels dial, in place of DNS and its checks;
  // by default a tunnel is refused, so no test reaches the network
  readonly resolveTunnelTarget?: (host: string) => Promise<string>;
  readonly dialTunnel?: (address: string, port: number) => Socket;

  // holds a broker request between its rule read and its value read
  readonly afterRuleRead?: () => Promise<void>;

  // the broker's token calls for oauth secrets, and its clock; its refresh
  // timer never runs in the harness, so no test reaches a token endpoint
  // unasked
  readonly oauthFetch?: OAuthFetch;
  readonly brokerNow?: () => number;

  // nft in place of the real one; by default it records each script
  readonly runNft?: (script: string) => Promise<void>;

  // what `iptables -S FORWARD` prints; setup-net's rules by default
  readonly forwardRules?: string;

  // each imp's tailnet name as a URL; none by default
  readonly readServiceUrl?: (name: string) => string | null;

  // the clock's start, also a sleep's timing clock; it moves only with
  // `advance` and a young guest wait's pauses, which take no real time
  readonly frozenClockMs?: number;

  // the storage backend over the data dir; XFS on plain files by default
  readonly createStorage?: (dataDir: string) => StorageBackend;

  // files that stand for /proc/sys/kernel/tainted, read on the harness's
  // clock, /proc/sys/kernel/random/boot_id, /dev/kmsg and /proc/self/ns/pid;
  // the kernel never oopses without them
  readonly kernelFiles?: {
    readonly taintPath: string;
    readonly bootIdPath: string;
    readonly kmsgPath: string;
    readonly pidNamespacePath: string;
  };

  // a dir that stands for /proc, where the sampler reads each VM's threads
  // from <pid>/task; no VM has a thread without it
  readonly procRoot?: string;

  // CPU limits: none enforced, and 8 cores, by default
  readonly cgroups?: CpuCgroups;
  readonly hostCpus?: number;

  // IPv6 for imps, as impd resolved it; none by default
  readonly ipv6?: Ipv6Plan;

  // the host container's default-route interfaces; eth0 in each family by
  // default
  readonly readUplinks?: () => Promise<Uplinks>;

  // IMP_KSM's readers: the unshared size a sleep records, the merge flag, and
  // the host counters
  readonly readUnsharedRamMib?: (pid: number) => number | null;
  readonly checkGuestMerge?: (pid: number) => Promise<boolean | null>;
  readonly readKsmProfitMib?: (pid: number) => Promise<number | null>;
  readonly readKsmHostStats?: () => KsmHostStats | null;

  // the jailer that releases and removes a stopped VM's jail, as
  // createVmRunner wires it; nothing to release by default
  readonly jails?: Jails;
}

// A shim over createImpd's parts, each release in `stack`, which the caller
// disposes. `restartImpd` starts a new impd on the same database, data dir
// and VMs; given an identity, as an upgrade would.
export async function createImpTest(
  stack: Readonly<AsyncDisposableStack>,
  options: ImpTestOptions = {},
) {
  const dataDir = options.dataDir ?? mkdtempSync(`${tmpdir()}/impd-test-`);

  if (options.dataDir === undefined) {
    stack.defer(() => {
      rmSync(dataDir, { recursive: true, force: true });
    });
  }

  const db = await openDatabase(':memory:');

  stack.defer(async () => {
    await db.destroy();

    options.onLog?.('test harness: database closed');
  });

  // a new disk stays the size of its image: the fake clone copies every byte
  const config: Config = {
    // unjailed unless a test asks: the fake VMs have no cgroups
    ...loadConfig({
      IMP_DATA_DIR: dataDir,
      IMP_BOOT_TEMPLATES: 'false',
      IMP_JAILER: 'false',
      ...options.env,
    }),
    defaultDiskBytes: 0,
  };

  const fake = buildStubVmm();
  const taps: string[] = [];
  const removedTaps: string[] = [];
  const logs: string[] = [];

  // disks whose filesystem the host grew; the test disks hold no ext4
  const filesystemGrows: string[] = [];

  // the clock for holds and reservations; a test moves it with `advance`
  const clock = { offsetMs: 0 };
  const frozenAt = options.frozenClockMs;
  const readClock = () => (frozenAt ?? Date.now()) + clock.offsetMs;

  const cloneDisk =
    options.cloneDisk ??
    ((source: string, target: string) => {
      copyFileSync(source, target);

      return Promise.resolve();
    });

  const storage =
    options.createStorage?.(dataDir) ?? createXfsBackend({ dataDir, cloneFile: cloneDisk });

  // the host's free space as the budget sees it; a test lowers it
  const diskUsage = { usedBytes: 0, availableBytes: 1024 ** 4 };

  const printTestLog = (message: string): void => {
    logs.push(message);
    options.onLog?.(message);
  };

  // each unexpected failure the API's router hit, as impd would log it to
  // stderr; the stub VMM makes plenty on purpose
  const rpcFailures: unknown[] = [];

  const printRpcFailure = (failure: unknown): void => {
    rpcFailures.push(failure);

    printTestLog(`impd: rpc failed: ${Bun.inspect(failure)}`);
  };

  // a system drive file, as setupSystemFiles installs it
  const createSystemDrive = (drive: string): HostIdentity => {
    const identity = buildTestIdentity(dataDir, drive);

    mkdirSync(buildSystemDrivesDir(dataDir), { recursive: true });
    writeFileSync(identity.systemDrivePath, drive);

    return identity;
  };

  const host = { identity: createSystemDrive(TEST_DRIVE) };

  // the vsock paths the broker installed its CA through
  const bundleInstalls: string[] = [];

  // every nft script and conntrack flush the egress firewall ran
  const nftScripts: string[] = [];
  const flushed: string[] = [];
  const flushedPairs: string[] = [];

  // each policy change's call to end the broker's tunnels, with its keep
  const closedTunnels: { impId: string; keep: (host: string) => boolean }[] = [];

  // each limit impd sets on an imp's memory, in order
  const memoryLimits: { impId: string; guestMib: number }[] = [];

  const deps: ImpdDeps = {
    ...buildTestDeps({
      db,
      dataDir,
      storage,
      systemDrivePath: host.identity.systemDrivePath,
      now: readClock,
      log: printTestLog,
      logRpcFailure: printRpcFailure,
    }),
    readDiskSpace: () => Promise.resolve({ ...diskUsage }),
    broker: {
      installBundle:
        options.installBundle ??
        ((vsockPath) => {
          bundleInstalls.push(vsockPath);

          return Promise.resolve();
        }),
      resolveTunnelTarget:
        options.resolveTunnelTarget ??
        ((name) => Promise.reject(new TunnelRefusedError(`${name}: no network in tests`))),
      ...(options.dialTunnel !== undefined && { dialTunnel: options.dialTunnel }),
      ...(options.afterRuleRead !== undefined && { afterRuleRead: options.afterRuleRead }),
      ...(options.oauthFetch !== undefined && { oauthFetch: options.oauthFetch }),

      // on the wall clock unless a test asks, as before the harness's clock
      // reached createImpd's broker
      now: options.brokerNow ?? Date.now,
      runOAuthTimer: false,
    },
    egress: {
      runNft:
        options.runNft ??
        ((script) => {
          nftScripts.push(script);

          return Promise.resolve();
        }),
      flushConnections: (guestIp) => {
        flushed.push(guestIp);

        return Promise.resolve();
      },
      readForwardRules: () =>
        Promise.resolve(
          options.forwardRules ??
            '-A FORWARD -i imp+ -o imp+ -m mark --mark 0x1000000/0x1000000 -m comment --comment imp-network -j ACCEPT\n',
        ),
      flushPair: (first, second) => {
        flushedPairs.push(`${first} ${second}`);

        return Promise.resolve();
      },
      forward: () => Promise.reject(new Error('no upstream in tests')),
      resolveExact: () => Promise.resolve([]),
      readConnected6: () => Promise.resolve(['2001:db8:a::/64']),
      readConnected4: () => Promise.resolve(['172.17.0.0/16', '172.17.0.2/32', '44.0.0.0/24']),
      readUplinks:
        options.readUplinks ?? (() => Promise.resolve({ ipv4: ['eth0'], ipv6: ['eth0'] })),
    },
    imps: {
      readRamMib: (pid) => (fake.alive.has(pid) ? FAKE_VM_RAM_MIB : null),
      readRssMib: (pid) => (fake.alive.has(pid) ? FAKE_VM_RSS_MIB : null),
      growFilesystem: (disk) => {
        filesystemGrows.push(disk);

        return options.growFilesystem?.(disk) ?? Promise.resolve(true);
      },

      // recorded, then written as main.ts does when a test passes cgroups
      memoryLimit: {
        setGuestMib: (impId, guestMib) => {
          memoryLimits.push({ impId, guestMib });
          options.cgroups?.setGuestMib(impId, guestMib);
        },
      },
      hostCpus: options.hostCpus ?? 8,
      kernelOops:
        options.kernelFiles === undefined
          ? NO_KERNEL_OOPS
          : createKernelOopsWatch(
              options.kernelFiles.taintPath,
              readClock,
              options.kernelFiles.bootIdPath,
              {
                kmsgPath: options.kernelFiles.kmsgPath,
                pidNamespacePath: options.kernelFiles.pidNamespacePath,
              },
            ),
      readThreadIds: (pid) =>
        options.procRoot === undefined ? null : readThreadIds(pid, options.procRoot),
      ...(frozenAt !== undefined && {
        sleepTiming: {
          now: readClock,
          sleep: (durationMs: number) => {
            clock.offsetMs += durationMs;

            return Promise.resolve();
          },
        },
      }),
      ...(options.readUnsharedRamMib !== undefined && {
        readUnsharedRamMib: options.readUnsharedRamMib,
      }),
      ...(options.checkGuestMerge !== undefined && { checkGuestMerge: options.checkGuestMerge }),
      ...(options.readKsmProfitMib !== undefined && { readKsmProfitMib: options.readKsmProfitMib }),
    },
    taps: {
      setupTap: (address) => {
        taps.push(address.tap);

        return Promise.resolve();
      },
      removeTap: (tap) => {
        removedTaps.push(tap);

        return Promise.resolve();
      },
    },
  };

  const stored = createImpdStorage(config, deps);

  stack.defer(() => {
    stored.diskUsage.stop();
  });

  const broker = await createImpdBroker(config, deps, {
    ipv6: options.ipv6 ?? null,
    secretFiles: createSecretFiles(dataDir),
  });

  stack.defer(() => broker.stop());

  const egress = createImpdEgress(config, deps, {
    ipv6: options.ipv6 ?? null,
    broker: {
      isGranted: broker.isGranted,
      closeTunnels: (impId, keep) => {
        closedTunnels.push({ impId, keep });
        broker.closeTunnels(impId, keep);
      },
    },
  });

  stack.defer(() => {
    fake.releaseHangs();
  });

  const governedParts: GovernedParts = {
    storage: stored,
    broker,
    egress,
    ipv6: options.ipv6 ?? null,
    cgroups: options.cgroups ?? createCpuCgroups({ root: '/nonexistent', log: printTestLog }),
    readServiceUrl: options.readServiceUrl ?? (() => null),
    readTailscale: readNoTailscale,
  };

  const startImpd = (identity: HostIdentity = host.identity) => {
    host.identity = identity;

    const runner = fake.startGeneration();
    const jails = options.jails;

    const vms =
      jails === undefined
        ? runner
        : {
            ...runner,
            releaseVm: (paths: ImpPaths) => jails.release(paths.impId),
            removeJail: (paths: ImpPaths) => jails.remove(paths.impId),
          };

    const started = startGovernedImps(config, deps, governedParts, identity, vms);

    // as main.ts stops them: a template build still running would write
    // into the data dir after its removal. A hung build is released first;
    // one a replacement parked never ends, and builds run one at a time.
    stack.defer(async () => {
      fake.releaseHangs();

      await Promise.race([started.imps.bootTemplates?.stop(), fake.whenTemplateBuildParks(runner)]);
    });

    return started;
  };

  const governed = startImpd();
  const builders = startImpdBuilders(config, deps, stored, governed.imps);

  const access = await loadImpdAccess(config, deps, () => false);

  // an image row whose rootfs is a small file in the data dir
  const createTestImage = async (name: string): Promise<ImageRecord> => {
    await Bun.write(`${dataDir}/images/${name}/rootfs.ext4`, 'rootfs');

    return createImage(db, { name, ref: `${name}:latest`, digest: `sha256:${name}`, sizeBytes: 6 });
  };

  return {
    config,
    db,
    dataDir,
    images: stored.images,
    builders,
    fake,
    taps,
    removedTaps,
    logs,
    log: printTestLog,
    rpcFailures,
    logRpcFailure: printRpcFailure,
    filesystemGrows,
    imps: governed.imps,
    governor: governed.governor,
    memory: governed.memory,
    memoryLimits,
    broker,
    egress,
    nftScripts,
    flushed,
    flushedPairs,
    closedTunnels,
    bundleInstalls,
    storage,
    storageGate: stored.storageGate,
    diskBudget: stored.diskBudget,
    diskUsage,
    tokens: access.tokens,
    revocations: access.revocations,
    oauth: access.oauth,
    now: readClock,
    advance: (durationMs: number) => {
      clock.offsetMs += durationMs;
    },
    readKsmHostStats: options.readKsmHostStats ?? null,
    restartImpd: startImpd,
    createSystemDrive,
    readIdentity: () => host.identity,
    createTestImage,
  };
}

export type ImpTest = Awaited<ReturnType<typeof createImpTest>>;

// a memory snapshot as a sleep at `createdAt` by a VM with `identity`
// leaves it
export function writeTestSnapshot(
  paths: Readonly<ImpPaths>,
  createdAt: number,
  identity: Readonly<SnapshotIdentity>,
): void {
  mkdirSync(paths.snapshotDir, { recursive: true });
  writeFileSync(paths.vmstate, 'vmstate');
  writeFileSync(paths.memFile, 'mem');

  writeSnapshotMeta(paths, {
    ...identity,
    createdAt,
    memoryMib: 2048,
    ramMib: FAKE_VM_RAM_MIB,
  });
}
