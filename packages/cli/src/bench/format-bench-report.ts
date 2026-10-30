import { formatTable } from '../output/format-output';
import type { LatencySummary } from './bench-report-schema';
import type { BenchHostState, BenchReport } from './build-bench-report';

const HEADER = [
  'scenario',
  'conc',
  'samples',
  'failed',
  'p50',
  'p95',
  'p99',
  'impd p50',
  'mem file',
];

export function formatBenchReport(report: Readonly<BenchReport>): string {
  const host = report.host;

  const machine = [
    host.label,
    host.cpuModel,
    host.cpus === null ? null : `${String(host.cpus)} cpus`,
    host.kernel === null ? null : `kernel ${host.kernel}`,
    host.isNested === true ? 'nested' : null,
    `huge pages ${host.hugePages ?? 'unknown'}`,
    `storage ${host.storage}`,
    `impd ${host.impdVersion}`,
  ].filter((part) => part !== null);

  const rows = report.results.map((result) => [
    result.scenario,
    String(result.concurrency),
    String(result.samples),
    formatFailures(result.failures),
    ...formatLatency(result.latencyMs),
    result.impdMs === null ? '-' : `${String(result.impdMs.p50)}ms`,
    result.memFileMib === null ? '-' : `${String(result.memFileMib.p50)} MiB`,
  ]);

  return [
    `host: ${machine.join(', ')}`,
    `before: ${formatHostState(report.before)}`,
    `after: ${formatHostState(report.after)}`,
    '',
    formatTable(HEADER, rows),
  ].join('\n');
}

function formatFailures(failures: Readonly<Record<string, number>>): string {
  const entries = Object.entries(failures);

  if (entries.length === 0) {
    return '0';
  }

  return entries.map(([code, count]) => `${String(count)} ${code}`).join(', ');
}

function formatLatency(latency: LatencySummary | null): string[] {
  if (latency === null) {
    return ['-', '-', '-'];
  }

  return [latency.p50, latency.p95, latency.p99].map((value) => `${String(value)}ms`);
}

function formatHostState(state: Readonly<BenchHostState>): string {
  const templates =
    state.bootTemplates === null
      ? 'boot templates off'
      : `${String(state.bootTemplates)} boot templates`;

  const pool =
    state.hugePoolFreeMib === null
      ? 'no huge page pool'
      : `${String(state.hugePoolFreeMib)} MiB pool free`;

  return `${templates}, ${pool}, ${String(state.awakeCount)} of ${String(state.impCount)} imps awake`;
}
