import type { TailnetPeer } from './auth/tailnet-identity';
import type { BrokerDeps } from './broker/broker-service';
import type { AppDeps } from './build-app';
import type { DiskFreezer } from './checkpoints/consistent-disk';
import type { ImpdMoveBoundaries } from './create-impd-moves';
import type { ImpDatabase } from './db/open-database';
import type { EgressDeps } from './egress/egress-service';
import type { Repeat } from './images/build-event-stream';
import type { ImageServiceDeps } from './images/image-service';
import type { ImpService, ImpServiceDeps } from './imps/imp-service';
import type { Ipv6Plan } from './net/ipv6-plan';
import type { TailscaleStatus } from './net/tailscale-status';
import type { TapDevices } from './net/tap-devices';
import type { CommandRunner } from './process/run-command';
import type { TickerTimer } from './process/ticker';
import type { HostIdentity } from './sleep/vm-identity';
import type { SystemFiles } from './storage/setup-system-files';
import type { StorageBackend } from './storage/storage-backend';
import type { CpuCgroups } from './vmm/cpu-cgroups';
import type { KsmHostStats } from './vmm/ksm';
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
// grow, the host's cores, the memory limit, the agent's session taps and
// the kernel's taint flag
export type ImpBoundaries = Partial<
  Pick<
    ImpServiceDeps,
    | 'readRamMib'
    | 'readRssMib'
    | 'readUnsharedRamMib'
    | 'checkGuestMerge'
    | 'growFilesystem'
    | 'hostCpus'
    | 'memoryLimit'
    | 'now'
    | 'sleep'
    | 'sleepTiming'
    | 'openTap'
    | 'kernelOops'
    | 'readThreadIds'
  >
> & {
  // what KSM saves in a VM, which the RAM governor counts as headroom
  readonly readKsmProfitMib?: (pid: number) => Promise<number | null>;
};

// What impd reaches outside its own code once the host is set up: every
// field but the four required ones defaults to the host's real one. A test
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

  // the docker engine a host build talks to, and the image a first start pulls
  readonly images?: Pick<ImageServiceDeps, 'dockerEnv' | 'builderImagePullMs' | 'seedRef'>;

  // the other host of a move, and the source's own taps
  readonly moves?: ImpdMoveBoundaries;

  // the guest agent's exec and attach streams, as the API opens them; the
  // VM's own agent by default
  readonly agent?: Partial<Pick<ImpService, 'openExec' | 'openAttach'>>;

  // fsfreeze inside the guest, around a checkpoint or a template's disk
  readonly freezer?: DiskFreezer;

  // the gap between the progress events of a streamed image call;
  // BUILD_KEEPALIVE_MS by default
  readonly keepaliveMs?: number;

  // the timer of those progress events; runOnInterval by default
  readonly keepaliveRepeat?: Repeat;

  // the kernel's release and its KSM counters, which IMP_KSM needs
  readonly hostKernelRelease?: string;
  readonly readKsmHostStats?: () => KsmHostStats | null;

  // /proc/self/status, whose CapEff shows whether impd holds CAP_SETFCAP
  readonly readProcStatus?: () => string;

  // the timers impd's tickers wait on; the runtime's own by default
  readonly tickerTimer?: TickerTimer;

  // the wake proxy's Host-routed port and each slot's port; the config's
  // by default
  readonly proxyPorts?: { readonly proxy: number; readonly slot: (slot: number) => number };

  // how long the API lets a request idle; Elysia's 30 s by default
  readonly apiIdleTimeoutS?: number;
}

// What createImpd takes: the host's database, root token, storage and
// system files are made from the config unless the caller passes its own
export type ImpdBoundaries = Omit<ImpdDeps, 'db' | 'rootToken' | 'storage' | 'systemFiles'> &
  Partial<Pick<ImpdDeps, 'db' | 'rootToken' | 'storage' | 'systemFiles'>>;
