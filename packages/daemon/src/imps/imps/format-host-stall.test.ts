import { expect, test } from 'bun:test';
import { formatHostStall } from './format-host-stall';

test('it formats the growth of each figure between the two readings in milliseconds', () => {
  expect(
    formatHostStall(
      {
        cpuStallUs: 7_340_021,
        ioStallUs: 902_113,
        memoryStallUs: 1450,
        stealUs: 27_540_000,
        thpFaultAlloc: null,
        thpFaultFallback: null,
        compactStall: null,
      },
      {
        cpuStallUs: 7_752_400,
        ioStallUs: 905_700,
        memoryStallUs: 1450,
        stealUs: 28_190_000,
        thpFaultAlloc: null,
        thpFaultFallback: null,
        compactStall: null,
      },
    ),
  ).toBe('; host stall cpu=412ms io=4ms memory=0ms steal=650ms');
});

test('it leaves out a figure that one of the readings lacks', () => {
  expect(
    formatHostStall(
      {
        cpuStallUs: null,
        ioStallUs: 902_113,
        memoryStallUs: null,
        stealUs: 27_540_000,
        thpFaultAlloc: null,
        thpFaultFallback: null,
        compactStall: null,
      },
      {
        cpuStallUs: null,
        ioStallUs: 905_700,
        memoryStallUs: 1450,
        stealUs: 28_190_000,
        thpFaultAlloc: null,
        thpFaultFallback: null,
        compactStall: null,
      },
    ),
  ).toBe('; host stall io=4ms steal=650ms');
});

test('it formats nothing when neither reading holds a figure', () => {
  expect(
    formatHostStall(
      {
        cpuStallUs: null,
        ioStallUs: null,
        memoryStallUs: null,
        stealUs: null,
        thpFaultAlloc: null,
        thpFaultFallback: null,
        compactStall: null,
      },
      {
        cpuStallUs: null,
        ioStallUs: null,
        memoryStallUs: null,
        stealUs: null,
        thpFaultAlloc: null,
        thpFaultFallback: null,
        compactStall: null,
      },
    ),
  ).toBe('');
});

test('it formats the growth of the huge page counters after the stall figures', () => {
  expect(
    formatHostStall(
      {
        cpuStallUs: 1000,
        ioStallUs: null,
        memoryStallUs: null,
        stealUs: null,
        thpFaultAlloc: 50,
        thpFaultFallback: 1,
        compactStall: 7,
      },
      {
        cpuStallUs: 4000,
        ioStallUs: null,
        memoryStallUs: null,
        stealUs: null,
        thpFaultAlloc: 650,
        thpFaultFallback: 1,
        compactStall: 9,
      },
    ),
  ).toBe('; host stall cpu=3ms thp_fault_alloc=600 thp_fault_fallback=0 compact_stall=2');
});

test('it formats the huge page counters alone when the host has no stall figures', () => {
  const noStall = { cpuStallUs: null, ioStallUs: null, memoryStallUs: null, stealUs: null };

  expect(
    formatHostStall(
      { ...noStall, thpFaultAlloc: 1, thpFaultFallback: null, compactStall: null },
      { ...noStall, thpFaultAlloc: 3, thpFaultFallback: null, compactStall: null },
    ),
  ).toBe('; host thp_fault_alloc=2');
});
