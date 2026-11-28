import type { HostLoad } from '../../platform/process/read-host-load';

const STALL_FIGURES = [
  ['cpu', 'cpuStallUs'],
  ['io', 'ioStallUs'],
  ['memory', 'memoryStallUs'],
  ['steal', 'stealUs'],
] as const;

// The counts of /proc/vmstat, under its own names, so an operator can search a log for them.
const HUGE_PAGE_FIGURES = [
  ['thp_fault_alloc', 'thpFaultAlloc'],
  ['thp_fault_fallback', 'thpFaultFallback'],
  ['compact_stall', 'compactStall'],
] as const;

export function formatHostStall(before: Readonly<HostLoad>, after: Readonly<HostLoad>): string {
  const stalls = STALL_FIGURES.flatMap(([name, field]) => {
    const startUs = before[field];
    const endUs = after[field];

    return startUs === null || endUs === null
      ? []
      : [`${name}=${String(Math.round((endUs - startUs) / 1000))}ms`];
  });

  const hugePages = HUGE_PAGE_FIGURES.flatMap(([name, field]) => {
    const start = before[field];
    const end = after[field];

    return start === null || end === null ? [] : [`${name}=${String(end - start)}`];
  });

  const sections = [...(stalls.length === 0 ? [] : [`stall ${stalls.join(' ')}`]), ...hugePages];

  return sections.length === 0 ? '' : `; host ${sections.join(' ')}`;
}
