import type { SystemInfo } from '@impz/api';
import type { BenchSettings } from './bench-scenarios';
import type { BenchResult } from './run-bench';

export interface BenchHost {
  readonly label: string | null;
  readonly impdVersion: string;
  readonly kernel: string | null;
  readonly cpuModel: string | null;
  readonly cpus: number | null;
  readonly isNested: boolean | null;
  readonly ramBudgetMib: number;
  readonly storage: SystemInfo['storage']['backend'];
  readonly firecracker: string | null;
  readonly guestKernel: string | null;
  readonly isKsmRunning: boolean;
  readonly hugePages: NonNullable<SystemInfo['host']>['hugePages'] | null;
}

// what a run starts from and leaves behind, which moves the numbers: a cold
// boot-template cache restores nothing, and a full pool refuses 2 MiB guests
export interface BenchHostState {
  readonly bootTemplates: number | null;
  readonly hugePoolFreeMib: number | null;
  readonly awakeCount: number;
  readonly impCount: number;
}

export interface BenchReport {
  readonly runID: string;
  readonly startedAt: string;
  readonly host: BenchHost;
  readonly before: BenchHostState;
  readonly after: BenchHostState;
  readonly settings: BenchSettings & {
    readonly levels: readonly number[];
    readonly samples: number;
  };
  readonly results: readonly BenchResult[];
}

export interface BenchRunRecord {
  readonly runID: string;
  readonly startedAt: Date;
  readonly label: string | null;
  readonly before: SystemInfo;
  readonly after: SystemInfo;
  readonly settings: BenchReport['settings'];
  readonly results: readonly BenchResult[];
}

export function buildBenchReport(record: Readonly<BenchRunRecord>): BenchReport {
  const info = record.before;

  return {
    runID: record.runID,
    startedAt: record.startedAt.toISOString(),
    host: {
      label: record.label,
      impdVersion: info.version,
      kernel: info.host?.kernel ?? null,
      cpuModel: info.host?.cpuModel ?? null,
      cpus: info.cpu?.hostCpus ?? null,
      isNested: info.host?.isNested ?? null,
      ramBudgetMib: info.ramBudgetMib,
      storage: info.storage.backend,
      firecracker: info.firecrackerVersion,
      guestKernel: info.guestKernel.version,
      isKsmRunning: info.ksm?.running ?? false,
      hugePages: info.host?.hugePages ?? null,
    },
    before: buildHostState(record.before),
    after: buildHostState(record.after),
    settings: record.settings,
    results: record.results,
  };
}

function buildHostState(info: Readonly<SystemInfo>): BenchHostState {
  return {
    bootTemplates: info.host?.bootTemplates ?? null,
    hugePoolFreeMib: info.host?.hugePool?.freeMib ?? null,
    awakeCount: info.awakeCount,
    impCount: info.impCount,
  };
}
