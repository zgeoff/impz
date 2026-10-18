import type { Imp } from '@impz/api';
import { formatMib } from '@impz/shared';
import { formatDiskUsage } from './format-disk-usage';

// what the imp's storage takes over its disk size, as `impz top` shows it:
// `<=1.2 GiB / 32.0 GiB`
export function formatDiskUse(imp: Imp): string {
  const [used] = formatDiskUsage(imp.diskUsage);

  return `${used} / ${formatMib(imp.diskMib)}`;
}
