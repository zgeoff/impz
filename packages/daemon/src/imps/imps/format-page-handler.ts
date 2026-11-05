import type { UffdStats } from '../../vm/vmm/uffd-handler';

export function formatPageHandler(stats: Readonly<UffdStats> | undefined): string {
  return stats === undefined
    ? ''
    : `; page handler faults=${String(stats.faults)} blocks=${String(stats.blocks)} serve=${String(stats.serveMs)}ms`;
}
