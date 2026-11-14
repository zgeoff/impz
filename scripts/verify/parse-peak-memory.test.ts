import { expect, test } from 'bun:test';
import { parsePeakMemory } from './parse-peak-memory.ts';

test('it reads VmHWM in MiB from a process status', () => {
  const status = 'Name:\tbun\nVmPeak:\t 9000000 kB\nVmHWM:\t  163840 kB\nVmRSS:\t  120000 kB\n';

  expect(parsePeakMemory(status)).toBe(160);
});

test('it reads no peak from a status with no VmHWM line', () => {
  expect(parsePeakMemory('Name:\tbun\nState:\tS (sleeping)\n')).toBeNull();
});
