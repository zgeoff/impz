import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import type { ImpContract } from '@impz/api';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import type { InstallBundle } from '../src/broker/guest-trust';
import type { OAuthFetch } from '../src/broker/oauth-refresher';
import { TunnelRefusedError } from '../src/broker/tunnel-target';
import { loadConfig } from '../src/config';
import type { Config } from '../src/config';
import { createImpd } from '../src/create-impd';
import type { Impd } from '../src/create-impd';
import { createImage } from '../src/db/images';
import type { ImageRecord } from '../src/db/images';
import { openDatabase } from '../src/db/open-database';
import type { ImpdBoundaries } from '../src/impd-deps';
import { NO_KERNEL_OOPS, createKernelOopsWatch } from '../src/imps/kernel-oops-watch';
import type { Uplinks } from '../src/net/host-routes';
import type { Ipv6Plan } from '../src/net/ipv6-plan';
import type { HostIdentity } from '../src/sleep/vm-identity';
import { buildSystemDrivePath, buildSystemDrivesDir } from '../src/storage/data-layout';
import type { ImpPaths } from '../src/storage/data-layout';
import type { StorageBackend } from '../src/storage/storage-backend';
import { createXfsBackend } from '../src/storage/xfs-backend';
import { createCpuCgroups } from '../src/vmm/cpu-cgroups';
import type { CpuCgroups } from '../src/vmm/cpu-cgroups';
import type { Jails } from '../src/vmm/jail';
import type { KsmHostStats } from '../src/vmm/ksm';
import type { VmRunner } from '../src/vmm/vm-runner';
import { readThreadIds } from '../src/vmm/vm-stats';
import { readNoTailscale } from './network/read-no-tailscale';
import { buildStubTickerTimer } from './platform/build-stub-ticker-timer';
import { findFreePorts } from './platform/find-free-ports';
import { TEST_TOKEN } from './test-token';
import { buildStubVmm } from './vm/build-stub-vmm';

export interface TestImpdOptions {
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

  // the clock's start, also a sleep's timing clock; it moves only with
  // `advance` and a young guest wait's pauses, which take no real time
  readonly frozenClockMs?: number;

  // the storage backend over the data dir, for each impd the harness
  // starts; XFS on plain files by default
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

  // the root token the client sends; TEST_TOKEN by default
  readonly rootToken?: string;

  // any other boundary createImpd takes, over the harness's own
  readonly boundaries?: Partial<ImpdBoundaries>;
}

// every awake fake VM holds this much, as the governor measures it
const FAKE_VM_RAM_MIB = 300;
const FAKE_VM_RSS_MIB = 340;

// the sha256 of the system drive every test impd starts with
const TEST_DRIVE = 'd1'.repeat(32);

// what system.info reports about the guest kernel and the system drive
const TEST_SYSTEM_FILES = {
  guestKernel: { version: '6.1.188', sha256: 'a'.repeat(64) },
  systemDrive: { sha256: 'b'.repeat(64) },
};

// the freeze a checkpoint or a template asks of the guest; the fake VMs
// run no agent to ask
const NO_FREEZER = { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() };

// a kernel that keeps KSM's merge flag across exec, and a ksmd that runs
// and has merged nothing, for a test that turns IMP_KSM on
const KSM_KERNEL = '6.12.0';
const IDLE_KSM: KsmHostStats = { running: true, sharedMib: 0, profitMib: 0, zeroMib: 0 };

// impd as main.ts starts it, through createImpd, on the stub VMM and a
// stand-in for each host boundary, with its releases in the caller's `stack`.
// A ticker runs only when `tickers.fire` steps it.
export async function startTestImpd(
  stack: Readonly<AsyncDisposableStack>,
  options: TestImpdOptions = {},
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

  // the API's and the broker's ports, below the imps' port range
  const ports = findFreePorts(3, { pick: () => 10_000 + Math.floor(Math.random() * 10_000) });

  // a new disk stays the size of its image: the fake clone copies every byte
  const config: Config = {
    // unjailed unless a test asks: the fake VMs have no cgroups
    ...loadConfig({
      IMP_DATA_DIR: dataDir,
      IMP_BOOT_TEMPLATES: 'false',
      IMP_JAILER: 'false',
      IMP_API_PORT: String(ports.take()),
      IMP_BROKER_PORT: String(ports.take()),
      IMP_EGRESS_DNS_PORT: String(ports.take()),
      IMP_SSH_PORT: '0',
      ...options.env,
    }),
    defaultDiskBytes: 0,
  };

  const fake = buildStubVmm();
  const tickers = buildStubTickerTimer();
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

  const createStorage = (): StorageBackend =>
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

  // each limit impd sets on an imp's memory, in order
  const memoryLimits: { impId: string; guestMib: number }[] = [];

  const kernelOops =
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
        );

  const cgroups = options.cgroups ?? createCpuCgroups({ root: '/nonexistent', log: printTestLog });
  const extra = options.boundaries ?? {};

  const buildBoundaries = (identity: HostIdentity, runner: VmRunner): ImpdBoundaries => {
    const jails = options.jails;

    return {
      ...extra,
      db,
      rootToken: options.rootToken ?? TEST_TOKEN,
      storage: createStorage(),
      systemFiles: {
        kernelPath: `${dataDir}/system/vmlinux`,
        systemDrivePath: identity.systemDrivePath,
        info: TEST_SYSTEM_FILES,
      },
      log: printTestLog,
      logRpcFailure: printRpcFailure,
      now: readClock,
      readTailscale: extra.readTailscale ?? readNoTailscale,
      readDiskSpace: () => Promise.resolve({ ...diskUsage }),
      resolveIpv6: () => Promise.resolve(options.ipv6 ?? null),
      readIdentity: () => identity,
      cgroups,
      vms:
        jails === undefined
          ? runner
          : {
              ...runner,
              releaseVm: (paths: ImpPaths) => jails.release(paths.impId),
              removeJail: (paths: ImpPaths) => jails.remove(paths.impId),
            },
      freezer: extra.freezer ?? NO_FREEZER,
      hostKernelRelease: extra.hostKernelRelease ?? KSM_KERNEL,
      readKsmHostStats: options.readKsmHostStats ?? (() => IDLE_KSM),
      tickerTimer: tickers.timer,

      // any free port: the imps' ports are the config's to hand out
      proxyPorts: extra.proxyPorts ?? { proxy: 0, slot: () => 0 },
      images: { seedRef: null, ...extra.images },
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

        // on the wall clock unless a test asks
        now: options.brokerNow ?? Date.now,
        runOAuthTimer: false,
        ...extra.broker,
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
        ...extra.egress,
      },
      imps: {
        readRamMib: (pid) => (fake.alive.has(pid) ? FAKE_VM_RAM_MIB : null),
        readRssMib: (pid) => (fake.alive.has(pid) ? FAKE_VM_RSS_MIB : null),
        growFilesystem: (disk) => {
          filesystemGrows.push(disk);

          return options.growFilesystem?.(disk) ?? Promise.resolve(true);
        },

        // recorded, then written as impd does when a test passes cgroups
        memoryLimit: {
          setGuestMib: (impId, guestMib) => {
            memoryLimits.push({ impId, guestMib });
            options.cgroups?.setGuestMib(impId, guestMib);
          },
        },
        hostCpus: options.hostCpus ?? 8,
        kernelOops,
        readThreadIds: (pid) =>
          options.procRoot === undefined ? null : readThreadIds(pid, options.procRoot),
        ...(options.readUnsharedRamMib !== undefined && {
          readUnsharedRamMib: options.readUnsharedRamMib,
        }),
        ...(options.checkGuestMerge !== undefined && { checkGuestMerge: options.checkGuestMerge }),
        ...(options.readKsmProfitMib !== undefined && {
          readKsmProfitMib: options.readKsmProfitMib,
        }),
        ...(frozenAt !== undefined && {
          sleepTiming: {
            now: readClock,
            sleep: (ms: number) => {
              clock.offsetMs += ms;

              return Promise.resolve();
            },
          },
        }),
        ...extra.imps,
      },
    };
  };

  // as a crash leaves it: every ticker stopped and every port closed before
  // the next impd opens its own, but a lifecycle step under way never
  // waited for
  const stopImpd = async (impd: Impd): Promise<void> => {
    fake.releaseHangs();

    await impd.stop({ sleepImps: false, deadlineMs: 0 });
    await Promise.all([impd.app.server?.stop(true), impd.proxy.stop(), impd.broker.stop()]);
  };

  const startImpd = async (identity: HostIdentity): Promise<Impd> => {
    const runner = fake.startGeneration();

    const impd = await createImpd(config, buildBoundaries(identity, runner));

    // a template build still running would write into the data dir after
    // its removal. A hung build is released first; one a replacement parked
    // never ends, and builds run one at a time.
    stack.defer(async () => {
      fake.releaseHangs();

      await Promise.race([impd.imps.bootTemplates?.stop(), fake.whenTemplateBuildParks(runner)]);
    });

    stack.defer(async () => {
      if (current.impd === impd) {
        await stopImpd(impd);
      }
    });

    await impd.ready;

    return impd;
  };

  const current: { impd: Impd } = { impd: await startImpd(host.identity) };

  const buildClient = (token: string): ContractRouterClient<ImpContract> =>
    createORPCClient(
      new RPCLink({
        url: 'http://impd.test/rpc',
        headers: { authorization: `Bearer ${token}` },
        fetch: (request) => current.impd.api.app.handle(request),
      }),
    );

  const client = buildClient(options.rootToken ?? TEST_TOKEN);

  // an image row whose rootfs is a small file in the data dir
  const createTestImage = async (name: string): Promise<ImageRecord> => {
    await Bun.write(`${dataDir}/images/${name}/rootfs.ext4`, 'rootfs');

    return createImage(db, { name, ref: `${name}:latest`, digest: `sha256:${name}`, sizeBytes: 6 });
  };

  return {
    config,
    db,
    dataDir,
    fake,
    tickers,
    taps,
    removedTaps,
    logs,
    log: printTestLog,
    rpcFailures,
    logRpcFailure: printRpcFailure,
    filesystemGrows,
    memoryLimits,
    nftScripts,
    flushed,
    flushedPairs,
    bundleInstalls,
    diskUsage,
    now: readClock,
    advance: (ms: number) => {
      clock.offsetMs += ms;
    },
    createSystemDrive,
    createTestImage,
    readIdentity: () => host.identity,

    // a root client that calls the API without a socket, and one for any token
    client,
    buildClient,

    // the API on loopback, as a client outside the process reaches it
    get url(): string {
      return `http://127.0.0.1:${String(current.impd.app.server?.port)}`;
    },

    // the impd that runs now, and its parts
    get impd(): Impd {
      return current.impd;
    },
    get imps() {
      return current.impd.imps;
    },
    get governor() {
      return current.impd.governor;
    },
    get memory() {
      return current.impd.governed.memory;
    },
    get images() {
      return current.impd.images;
    },
    get builders() {
      return current.impd.builders;
    },
    get broker() {
      return current.impd.broker;
    },
    get egress() {
      return current.impd.egress;
    },
    get storage() {
      return current.impd.storage;
    },
    get storageGate() {
      return current.impd.storageGate;
    },
    get diskBudget() {
      return current.impd.diskBudget;
    },
    get tokens() {
      return current.impd.tokens;
    },
    get revocations() {
      return current.impd.revocations;
    },
    get oauth() {
      return current.impd.oauth;
    },
    get moves() {
      return current.impd.moves;
    },

    // a new impd on this one's database, data dir and VMs, after this one
    // stops as a crash would; with `identity`, as an upgrade would
    restartImpd: async (identity: HostIdentity = host.identity): Promise<Impd> => {
      await stopImpd(current.impd);

      host.identity = identity;

      current.impd = await startImpd(identity);

      return current.impd;
    },
  };
}

export type TestImpd = Awaited<ReturnType<typeof startTestImpd>>;

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
