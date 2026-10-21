import type { Imp } from '@impz/api';
import { formatMib } from '@impz/shared';
import { formatCpuUse } from './format-cpu-use';
import { formatDiskUsage } from './format-disk-usage';
import { formatNote } from './format-note';
import type { Row } from './format-output';

export function toImpRow(imp: Imp): Row {
  return [
    imp.name,
    imp.state,
    imp.image,
    String(imp.vcpus),
    formatMemory(imp),
    imp.ramMib === undefined ? '-' : `${String(imp.ramMib)} MiB`,
    formatMib(imp.diskMib),
    ...formatDiskUsage(imp.diskUsage),
    formatCpuUse(imp),
    imp.sessions === undefined ? '-' : String(imp.sessions),
    imp.ip,
    imp.url,
    formatNote(imp),
  ];
}

function formatMemory(imp: Imp): string {
  if (imp.maxMemoryMib === undefined) {
    return `${String(imp.memoryMib)} MiB`;
  }

  const nowMib = imp.memoryMib + (imp.pluggedMib ?? 0);

  return `${String(nowMib)}/${String(imp.maxMemoryMib)} MiB`;
}
