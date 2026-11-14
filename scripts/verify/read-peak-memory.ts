import { readFile } from 'node:fs/promises';
import { parsePeakMemory } from './parse-peak-memory.ts';

// The peak resident memory of this process, as the kernel counts it in /proc/self/status.
export async function readPeakMemory(): Promise<{ readonly peakMiB: number | null }> {
  const status = await readFile('/proc/self/status', 'utf8');

  return { peakMiB: parsePeakMemory(status) };
}
