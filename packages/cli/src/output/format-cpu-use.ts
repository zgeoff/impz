import type { Imp } from '@impz/api';

export function formatCpuUse(imp: Imp): string {
  const percent = imp.resources?.sample?.cpuPercent;
  const used = percent === undefined ? '-' : `${percent.toFixed(0)}%`;
  const limit = imp.cpu?.limit ?? null;

  return limit === null ? used : `${used} / ${String(limit)}`;
}
