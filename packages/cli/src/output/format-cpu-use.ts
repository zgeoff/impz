import type { Imp } from '@impz/api';

// the last sample's CPU, in percent of one core, over the limit when there is
// one: `45% / 1.5`
export function formatCpuUse(imp: Imp): string {
  const percent = imp.resources?.sample?.cpuPercent;
  const used = percent === undefined ? '-' : `${percent.toFixed(0)}%`;
  const limit = imp.cpu?.limit ?? null;

  return limit === null ? used : `${used} / ${String(limit)}`;
}
