import type { Imp } from '@impz/api';
import { formatBytes } from '@impz/shared';

export function formatDiskUsage(usage: Imp['diskUsage']): [string, string] {
  if (usage === undefined) {
    return ['-', '-'];
  }

  const bound = usage.isUpperBound ? '<=' : '';
  const partial = usage.isPartial ? '?' : '';

  return [
    `${bound}${formatBytes(usage.exclusiveBytes)}${partial}`,
    `${formatBytes(usage.sharedBytes)}${partial}`,
  ];
}
