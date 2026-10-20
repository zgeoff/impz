import type { BackupService } from './backup/backup-service';
import type { Broker } from './broker/broker-service';
import type { Config } from './config';
import { ENFORCE_INTERVAL_MS } from './governor/ram-governor';
import type { RamGovernor } from './governor/ram-governor';
import type { IdleLoop } from './idle/idle-loop';
import type { Imps } from './imps/imp-service';
import type { MemoryController } from './memory/memory-controller';
import { startTicker } from './process/ticker';
import type { Ticker, TickerTimer } from './process/ticker';
import type { WakeProxy } from './proxy/wake-proxy';
import type { DiskUsageCache } from './storage/disk-usage-cache';
import type { StorageGcService } from './storage/storage-gc';
import type { TailnetNames } from './tailnet-names/tailnet-names';

// What impd runs on a timer, each part as createImpd started it; null for a
// part the config leaves off
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

// Every ticker impd runs, each labelled for the timer that steps it, and
// the first disk usage pass soon after start, not a ticker interval later
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

    // elastic guests grow within a second of running low
    start('memory', 500, parts.memory.runTick),

    // listeners follow creates and destroys; this catches anything missed
    start('proxy', 30_000, parts.proxy.syncListeners),

    // names follow creates and destroys; this repairs what failed
    ...(parts.tailnetNames === null
      ? []
      : [start('tailnet-names', 600_000, parts.tailnetNames.runSync)]),

    // terminators follow grants; this also renews leaves near their end
    start('broker', 60_000, parts.broker.applyGrants),

    // what a crash or a failed removal left; start sweeps the same way
    start('gc', 3_600_000, parts.gc.runScheduled),

    // FIEMAP over every file on XFS: often enough for `impz ls`
    start('disk-usage', 300_000, parts.diskUsage.runPass),
    ...(parts.backups === null
      ? []
      : [
          start(
            'backup',

            // a run is due by the time since the last one, so a restart
            // never puts it off by a whole interval
            Math.min(config.backup?.intervalS ?? 0, 300) * 1000,
            parts.backups.runScheduled,
          ),
        ]),
  ];

  parts.diskUsage.requestRefresh();

  return tickers;
}
