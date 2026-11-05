import { expect, test } from 'bun:test';
import { formatHostStall } from './format-host-stall';

test('it formats the growth of each figure between the two readings in milliseconds', () => {
  expect(
    formatHostStall(
      { cpuStallUs: 7_340_021, ioStallUs: 902_113, memoryStallUs: 1450, stealUs: 27_540_000 },
      { cpuStallUs: 7_752_400, ioStallUs: 905_700, memoryStallUs: 1450, stealUs: 28_190_000 },
    ),
  ).toBe('; host stall cpu=412ms io=4ms memory=0ms steal=650ms');
});

test('it leaves out a figure that one of the readings lacks', () => {
  expect(
    formatHostStall(
      { cpuStallUs: null, ioStallUs: 902_113, memoryStallUs: null, stealUs: 27_540_000 },
      { cpuStallUs: null, ioStallUs: 905_700, memoryStallUs: 1450, stealUs: 28_190_000 },
    ),
  ).toBe('; host stall io=4ms steal=650ms');
});

test('it formats nothing when neither reading holds a figure', () => {
  expect(
    formatHostStall(
      { cpuStallUs: null, ioStallUs: null, memoryStallUs: null, stealUs: null },
      { cpuStallUs: null, ioStallUs: null, memoryStallUs: null, stealUs: null },
    ),
  ).toBe('');
});
