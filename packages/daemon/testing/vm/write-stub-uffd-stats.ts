import { writeFileSync } from 'node:fs';
import { UFFD_STATS_BYTES, UFFD_STATS_OFFSETS } from '../../src/vm/vmm/uffd-stats-layout';

// the counts a page handler writes to its stats file, as the handler keeps them
export interface StubUffdCounts {
  readonly faults: number;
  readonly blocks: number;
  readonly serveNs: number;
}

export function writeStubUffdStats(path: string, counts: Readonly<StubUffdCounts>): void {
  const raw = Buffer.alloc(UFFD_STATS_BYTES);

  raw.writeBigUInt64LE(BigInt(counts.faults), UFFD_STATS_OFFSETS.faults);
  raw.writeBigUInt64LE(BigInt(counts.blocks), UFFD_STATS_OFFSETS.blocks);
  raw.writeBigUInt64LE(BigInt(counts.serveNs), UFFD_STATS_OFFSETS.serveNs);

  writeFileSync(path, raw);
}
