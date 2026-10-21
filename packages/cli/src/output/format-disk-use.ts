import type { Imp } from '@impz/api';
import { formatMib } from '@impz/shared';
import { formatDiskUsage } from './format-disk-usage';

export function formatDiskUse(imp: Imp): string {
  const [used] = formatDiskUsage(imp.diskUsage);

  return `${used} / ${formatMib(imp.diskMib)}`;
}
