import type { HostLoad } from '../../platform/process/read-host-load';

const STALL_FIGURES = [
  ['cpu', 'cpuStallUs'],
  ['io', 'ioStallUs'],
  ['memory', 'memoryStallUs'],
  ['steal', 'stealUs'],
] as const;

export function formatHostStall(before: Readonly<HostLoad>, after: Readonly<HostLoad>): string {
  const figures = STALL_FIGURES.flatMap(([name, field]) => {
    const startUs = before[field];
    const endUs = after[field];

    return startUs === null || endUs === null
      ? []
      : [`${name}=${String(Math.round((endUs - startUs) / 1000))}ms`];
  });

  return figures.length === 0 ? '' : `; host stall ${figures.join(' ')}`;
}
