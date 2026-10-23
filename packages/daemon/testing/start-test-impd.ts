import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import type { ImpContract } from '@impz/api';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import invariant from 'tiny-invariant';
import { loadConfig } from '../src/config';
import type { Config } from '../src/config';
import { createImpd } from '../src/create-impd';
import type { Impd } from '../src/create-impd';
import type { Uplinks } from '../src/host-net/net/host-routes';
import type { Ipv6Plan } from '../src/host-net/net/ipv6-plan';
import type { ImpdBoundaries } from '../src/impd-deps';
import { NO_KERNEL_OOPS, createKernelOopsWatch } from '../src/imps/imps/kernel-oops-watch';
import type { InstallBundle } from '../src/network/broker/guest-trust';
import type { OAuthFetch } from '../src/network/broker/oauth-refresher';
import { TunnelRefusedError } from '../src/network/broker/tunnel-target';
import { createImage } from '../src/platform/db/images';
import type { ImageRecord } from '../src/platform/db/images';
import { openDatabase } from '../src/platform/db/open-database';
import type { ImpDatabase } from '../src/platform/db/open-database';
import type { HostIdentity } from '../src/vm/sleep/vm-identity';
import { buildSystemDrivePath, buildSystemDrivesDir } from '../src/vm/storage/data-layout';
import type { ImpPaths } from '../src/vm/storage/data-layout';
import type { StorageBackend } from '../src/vm/storage/storage-backend';
import { createXfsBackend } from '../src/vm/storage/xfs-backend';
import { createCpuCgroups } from '../src/vm/vmm/cpu-cgroups';
import type { CpuCgroups } from '../src/vm/vmm/cpu-cgroups';
import type { Jails } from '../src/vm/vmm/jail';
import type { KsmHostStats } from '../src/vm/vmm/ksm';
import type { VmRunner } from '../src/vm/vmm/vm-runner';
import { readThreadIds } from '../src/vm/vmm/vm-stats';
import { readNoTailscale } from './network/read-no-tailscale';
import { buildStubTickerTimer } from './platform/build-stub-ticker-timer';
import { claimFreePorts } from './platform/claim-free-ports';
import { pickImpdPort } from './platform/pick-impd-port';
import { TEST_TOKEN } from './test-token';
import { buildStubVmm } from './vm/build-stub-vmm';

export interface TestImpdOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly dataDir?: string;

  // a plain copy by default, because the test tmpdir is not XFS
  readonly cloneDisk?: (source: string, target: string) => Promise<void>;
  readonly growFilesystem?: (disk: string) => Promise<boolean>;
  readonly onLog?: (message: string) => void;
  readonly installBundle?: InstallBundle;
  readonly resolveTunnelTarget?: (host: string) => Promise<string>;
  readonly dialTunnel?: (address: string, port: number) => Socket;
  readonly afterRuleRead?: () => Promise<void>;
  readonly oauthFetch?: OAuthFetch;
  readonly brokerNow?: () => number;
  readonly runNft?: (script: string) => Promise<void>;
  readonly forwardRules?: string;

  // the clock moves only with `advance` and with a young guest's wait, which takes no real time
  readonly frozenClockMs?: number;
  readonly createStorage?: (dataDir: string) => StorageBackend;
  readonly kernelFiles?: {
    readonly taintPath: string;
    readonly bootIdPath: string;
    readonly kmsgPath: string;
    readonly pidNamespacePath: string;
  };
  readonly procRoot?: string;
  readonly cgroups?: CpuCgroups;
  readonly hostCpus?: number;
  readonly ipv6?: Ipv6Plan;
  readonly readUplinks?: () => Promise<Uplinks>;
  readonly readUnsharedRamMib?: (pid: number) => number | null;
  readonly checkGuestMerge?: (pid: number) => Promise<boolean | null>;
  readonly readKsmProfitMib?: (pid: number) => Promise<number | null>;
  readonly readKsmHostStats?: () => KsmHostStats | null;
  readonly jails?: Jails;
  readonly rootToken?: string;
  readonly wrapDatabase?: (db: ImpDatabase) => ImpDatabase;
  readonly boundaries?: Partial<ImpdBoundaries>;
}

const FAKE_VM_RAM_MIB = 300;
const FAKE_VM_RSS_MIB = 340;
const TEST_DRIVE = 'd1'.repeat(32);

const TEST_SYSTEM_FILES = {
  guestKernel: { version: '6.1.188', sha256: 'a'.repeat(64) },
  systemDrive: { sha256: 'b'.repeat(64) },
};

// the fake VMs run no guest agent to freeze the disk
const NO_FREEZER = { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() };

// a kernel release that keeps KSM's merge flag
const KSM_KERNEL = '6.12.0';
const IDLE_KSM: KsmHostStats = { running: true, sharedMib: 0, profitMib: 0, zeroMib: 0 };

export async function startTestImpd(
  stack: Readonly<AsyncDisposableStack>,
  options: TestImpdOptions = {},
) {
  const dataDir = options.dataDir ?? mkdtempSync(`${tmpdir()}/impd-test-`);

  if (options.dataDir === undefined) {
    stack.defer(() => rm(dataDir, { recursive: true, force: true }));
  }

  const db = await openDatabase(':memory:');

  stack.defer(async () => {
    await db.destroy();

    options.onLog?.('test harness: database closed');
  });

  const ports = claimFreePorts(3, {
    pick: () => pickImpdPort(Math.random()),
    onRelease: stack.defer.bind(stack),
  });

  // a new disk stays the size of its image, because the fake clone copies every byte
  const config: Config = {
    // unjailed unless a test asks, because the fake VMs have no cgroups
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
  const filesystemGrows: string[] = [];

  const clock: { frozenAt: number | undefined; offsetMs: number } = {
    frozenAt: options.frozenClockMs,
    offsetMs: 0,
  };

  const readClock = () => (clock.frozenAt ?? Date.now()) + clock.offsetMs;

  const cloneDisk =
    options.cloneDisk ??
    ((source: string, target: string) => {
      copyFileSync(source, target);

      return Promise.resolve();
    });

  const createStorage = (): StorageBackend =>
    options.createStorage?.(dataDir) ?? createXfsBackend({ dataDir, cloneFile: cloneDisk });

  const diskUsage = { usedBytes: 0, availableBytes: 1024 ** 4 };

  const printTestLog = (message: string): void => {
    logs.push(message);
    options.onLog?.(message);
  };

  const rpcFailures: unknown[] = [];

  const printRpcFailure = (failure: unknown): void => {
    rpcFailures.push(failure);

    printTestLog(`impd: rpc failed: ${Bun.inspect(failure)}`);
  };

  const createSystemDrive = (drive: string): HostIdentity => {
    const identity = buildTestIdentity(dataDir, drive);

    mkdirSync(buildSystemDrivesDir(dataDir), { recursive: true });
    writeFileSync(identity.systemDrivePath, drive);

    return identity;
  };

  const host = { identity: createSystemDrive(TEST_DRIVE) };
  const bundleInstalls: string[] = [];
  const nftScripts: string[] = [];
  const flushed: string[] = [];
  const flushedPairs: string[] = [];
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

  const buildBoundaries = (
    identity: HostIdentity,
    runner: VmRunner,
    storage: StorageBackend,
  ): ImpdBoundaries => {
    const jails = options.jails;

    return {
      ...extra,
      db: options.wrapDatabase?.(db) ?? db,
      rootToken: options.rootToken ?? TEST_TOKEN,
      storage,
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
      proxyPorts: extra.proxyPorts ?? { proxy: 0, slot: () => 0 },

      // loopback only, because the fixed test token is root to anyone who reaches the API
      apiHostname: '127.0.0.1',
      images: { seedRef: null, ...extra.images },
      taps: extra.taps ?? {
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
        ...extra.egress,
      },
      reach: {
        readConnected6: () => Promise.resolve(['2001:db8:a::/64']),
        readConnected4: () => Promise.resolve(['172.17.0.0/16', '172.17.0.2/32', '44.0.0.0/24']),
        readUplinks:
          options.readUplinks ?? (() => Promise.resolve({ ipv4: ['eth0'], ipv6: ['eth0'] })),
        ...extra.reach,
      },
      imps: {
        readRamMib: (pid) => (fake.alive.has(pid) ? FAKE_VM_RAM_MIB : null),
        readRssMib: (pid) => (fake.alive.has(pid) ? FAKE_VM_RSS_MIB : null),
        growFilesystem: (disk) => {
          filesystemGrows.push(disk);

          return options.growFilesystem?.(disk) ?? Promise.resolve(true);
        },
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
        ...(options.frozenClockMs !== undefined && {
          sleepTiming: {
            now: readClock,
            sleep: (durationMs: number) => {
              clock.offsetMs += durationMs;

              return Promise.resolve();
            },
          },
        }),
        ...extra.imps,
      },
    };
  };

  const stopImpd = async (impd: Impd): Promise<void> => {
    fake.releaseHangs();

    await impd.stop({ sleepImps: false, deadlineMs: 0 });
    await Promise.all([impd.app.server?.stop(true), impd.proxy.stop(), impd.broker.stop()]);
  };

  const startImpd = async (identity: HostIdentity, runner: VmRunner): Promise<Impd> => {
    const impd = await createImpd(config, buildBoundaries(identity, runner, createStorage()));

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

  const current = { impd: await startImpd(host.identity, fake.startGeneration()) };
  const sendRequest = (request: Request) => current.impd.api.app.handle(request);

  const buildClient = (token: string): ContractRouterClient<ImpContract> =>
    createORPCClient(
      new RPCLink({
        url: 'http://impd.test/rpc',
        headers: { authorization: `Bearer ${token}` },
        fetch: sendRequest,
      }),
    );

  const client = buildClient(options.rootToken ?? TEST_TOKEN);

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
    advance: (durationMs: number) => {
      clock.offsetMs += durationMs;
    },
    setClock: (nowMs: number) => {
      invariant(options.frozenClockMs !== undefined, 'setClock needs a frozen clock');

      clock.frozenAt = nowMs;
      clock.offsetMs = 0;
    },
    createSystemDrive,
    createTestImage,
    readIdentity: () => host.identity,
    client,
    buildClient,
    get url(): string {
      return `http://127.0.0.1:${String(current.impd.app.server?.port)}`;
    },
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

    // the old impd stops as a crash would leave it
    restartImpd: async (identity: HostIdentity = host.identity): Promise<Impd> => {
      // first, so a hung call the stop releases parks instead of finishing
      const runner = fake.startGeneration();

      await stopImpd(current.impd);

      host.identity = identity;

      current.impd = await startImpd(identity, runner);

      return current.impd;
    },
  };
}

export type TestImpd = Awaited<ReturnType<typeof startTestImpd>>;

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
