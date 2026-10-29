import type { ImpdMoveBoundaries } from './create-impd-moves';
import type { Ipv6Plan } from './host-net/net/ipv6-plan';
import type { ReachBoundaries } from './host-net/net/reach-policy';
import type { TailscaleStatus } from './host-net/net/tailscale-status';
import type { TapDevices } from './host-net/net/tap-devices';
import type { TailnetPeer } from './identity/auth/tailnet-identity';
import type { Repeat } from './imps/images/build/image-op-stream';
import type { ImageServiceDeps } from './imps/images/image-service';
import type { DiskFreezer } from './imps/imps/consistent-disk';
import type { ImpService, ImpServiceDeps } from './imps/imps/imp-service';
import type { BrokerDeps } from './network/broker/broker-service';
import type { EgressDeps } from './network/egress/egress-service';
import type { ImpDatabase } from './platform/db/open-database';
import type { StartTimer } from './platform/process/clock';
import type { CommandRunner } from './platform/process/run-command';
import type { TickerTimer } from './platform/process/ticker';
import type { TestRegistryBoundaries } from './resolve-test-registry';
import type { AppDeps } from './surface/create-app';
import type { HostIdentity } from './vm/sleep/vm-identity';
import type { SystemFiles } from './vm/storage/setup-system-files';
import type { StorageBackend } from './vm/storage/storage-backend';
import type { CpuCgroups } from './vm/vmm/cpu-cgroups';
import type { KsmHostStats } from './vm/vmm/ksm';
import type { HugePagePool } from './vm/vmm/read-huge-page-pool';
import type { VmRunner } from './vm/vmm/vm-runner';

type BrokerBoundaries = Pick<
  BrokerDeps,
  'installBundle' | 'fetch' | 'oauthFetch' | 'now' | 'resolveTunnelTarget' | 'dialTunnel'
>;

type EgressBoundaries = Pick<
  EgressDeps,
  | 'runNft'
  | 'flushConnections'
  | 'flushPair'
  | 'readForwardRules'
  | 'forward'
  | 'resolveExact'
  | 'now'
  | 'repeat'
>;

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
    | 'readNetBytes'
  >
> & {
  readonly readKsmProfitMib?: (pid: number) => Promise<number | null>;
  readonly readHugePagePool?: () => HugePagePool | null;
  readonly readHugetlbMib?: (pid: number, apiSocket: string) => Promise<number | null>;
};

export interface ImpdDeps {
  readonly db: ImpDatabase;
  readonly rootToken: string;
  readonly storage: StorageBackend;
  readonly systemFiles: SystemFiles;
  readonly logRpcFailure?: AppDeps['logRpcFailure'];
  readonly now?: () => number;
  readonly readDiskSpace?: StorageBackend['readUsage'];
  readonly resolveIpv6?: () => Promise<Ipv6Plan | null>;
  readonly readTailscale?: () => Promise<TailscaleStatus>;
  readonly whois?: (address: string) => Promise<TailnetPeer | null>;
  readonly cgroups?: CpuCgroups;
  readonly readIdentity?: (
    systemFiles: Readonly<SystemFiles>,
    ipv6Prefix: string | null,
  ) => HostIdentity;
  readonly vms?: VmRunner;
  readonly runCommand?: CommandRunner;
  readonly taps?: TapDevices;
  readonly broker?: BrokerBoundaries;
  readonly egress?: EgressBoundaries;
  readonly reach?: Partial<ReachBoundaries>;
  readonly testRegistry?: Partial<TestRegistryBoundaries>;
  readonly imps?: ImpBoundaries;
  readonly images?: Pick<ImageServiceDeps, 'builderImagePullMs' | 'seedRef'>;
  readonly moves?: ImpdMoveBoundaries;
  readonly agent?: Partial<Pick<ImpService, 'openExec' | 'openAttach' | 'openBuilderExec'>>;
  readonly freezer?: DiskFreezer;
  readonly keepaliveMs?: number;
  readonly keepaliveRepeat?: Repeat;
  readonly hostKernelRelease?: string;
  readonly readKsmHostStats?: () => KsmHostStats | null;
  readonly readProcStatus?: () => string;
  readonly tickerTimer?: TickerTimer;
  readonly buildUploadTimer?: StartTimer;
  readonly proxyPorts?: { readonly proxy: number; readonly slot: (slot: number) => number };

  // Elysia's own default is 30 s
  readonly apiIdleTimeoutS?: number;
  readonly apiHostname?: string;
}

export type ImpdBoundaries = Omit<ImpdDeps, 'db' | 'rootToken' | 'storage' | 'systemFiles'> &
  Partial<Pick<ImpdDeps, 'db' | 'rootToken' | 'storage' | 'systemFiles'>>;
