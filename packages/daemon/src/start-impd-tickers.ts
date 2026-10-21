import type { Config } from './config';
import type { BackupService } from './imp-ops/backup/backup-service';
import type { IdleLoop } from './imp-ops/idle/idle-loop';
import type { Imps } from './imps/imps/imp-service';
import type { Broker } from './network/broker/broker-service';
import type { WakeProxy } from './network/proxy/wake-proxy';
import type { TailnetNames } from './network/tailnet-names/tailnet-names';
import { startTicker } from './platform/process/ticker';
import type { Ticker, TickerTimer } from './platform/process/ticker';
import { ENFORCE_INTERVAL_MS } from './vm/governor/ram-governor';
import type { RamGovernor } from './vm/governor/ram-governor';
import type { MemoryController } from './vm/memory/memory-controller';
import type { DiskUsageCache } from './vm/storage/disk-usage-cache';
import type { StorageGcService } from './vm/storage/storage-gc';

export interface ImpdTickerParts {
  readonly idle: Pick<IdleLoop, 'runCheck'>;
  readonly oauth: { readonly removeExpired: () => Promise<void> };
  readonly governor: Pick<RamGovernor, 'enforce'>;
  readonly imps: Pick<Imps, 'sampleResources' | 'sweepSessionLogs'>;
  readonly memory: Pick<MemoryController, 'runTick'>;
  readonly proxy: Pick<WakeProxy, 'syncListeners'>;
  readonly tailnetNames: Pick<TailnetNames, 'runSync'> | null;
  readonly broker: Pick<Broker, 'applyGrants'>;
  readonly gc: Pick<StorageGcService, 'runScheduled'>;
  readonly diskUsage: Pick<DiskUsageCache, 'runPass' | 'requestRefresh'>;
  readonly backups: Pick<BackupService, 'runScheduled'> | null;
}

export function startImpdTickers(
  config: Config,
  parts: Readonly<ImpdTickerParts>,
  options: Readonly<{ log: (message: string) => void; timer?: TickerTimer }>,
): Ticker[] {
  const log = options.log;

  const start = (label: string, intervalMs: number, task: () => Promise<void>): Ticker =>
    startTicker(label, intervalMs, task, log, options.timer);

  const tickers = [
    start('idle', 2000, parts.idle.runCheck),
    start('oauth-expiry', 3_600_000, parts.oauth.removeExpired),
    start('governor', ENFORCE_INTERVAL_MS, parts.governor.enforce),
    start('resources', 5000, parts.imps.sampleResources),
    start('session-logs', 60_000, parts.imps.sweepSessionLogs),
    start('memory', 500, parts.memory.runTick),
    start('proxy', 30_000, parts.proxy.syncListeners),
    ...(parts.tailnetNames === null
      ? []
      : [start('tailnet-names', 600_000, parts.tailnetNames.runSync)]),
    start('broker', 60_000, parts.broker.applyGrants),
    start('gc', 3_600_000, parts.gc.runScheduled),

    // a pass runs FIEMAP over every file on XFS, so it runs rarely
    start('disk-usage', 300_000, parts.diskUsage.runPass),
    ...(parts.backups === null
      ? []
      : [
          start(
            'backup',

            // a run falls due by the time since the last one, so a short tick keeps a restart
            // from putting it off by a whole interval
            Math.min(config.backup?.intervalS ?? 0, 300) * 1000,
            parts.backups.runScheduled,
          ),
        ]),
  ];

  parts.diskUsage.requestRefresh();

  return tickers;
}
