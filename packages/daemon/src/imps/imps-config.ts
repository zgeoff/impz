import type { VmConfig } from '../vm/vm-config';
import type { SessionLogLimits } from './session-logs/session-log-service';

interface BuildConfig {
  readonly isolation: 'imp' | 'host';
  readonly memoryMib: number;
  readonly diskBytes: number;
  readonly imageMaxBytes: number;
  readonly imageMaxFiles: number;
  readonly image: string;
}

export interface ImageEvictionConfig {
  readonly highPercent: number;
  readonly lowPercent: number;
}

export interface ImpHttpsConfig {
  readonly domain: string;
  readonly httpsPort: number;
  readonly public: unknown;
}

export interface ImpsConfig extends VmConfig {
  readonly proxyPort: number;
  readonly bootReservePercent: number;
  readonly wakeReserveMib: number;

  // a guest slept too young loses its clock on the next wake
  readonly sleepMinGuestUptimeMs: number;
  readonly bootTemplates: boolean;
  readonly defaultVcpus: number;
  readonly defaultMemoryMib: number;
  readonly defaultDiskBytes: number;
  readonly diskReserveBytes: number | null;
  readonly buildContextMaxBytes: number;
  readonly build: BuildConfig;
  readonly imageEviction: ImageEvictionConfig | null;
  readonly sessionLog: SessionLogLimits;
  readonly dockerHost: string | null;
  readonly defaultImage: string;

  // a node with no key is still on the tailnet when the entrypoint started tailscaled from
  // saved node state after bootstrap blanked the spent key
  readonly tailscaleEnabled: boolean;

  // Tailscale gives the node another name while an older node holds this one
  readonly tailscaleHostname: string;
  readonly https: ImpHttpsConfig | null;
}
