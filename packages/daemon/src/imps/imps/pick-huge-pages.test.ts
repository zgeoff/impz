import { expect, test } from 'bun:test';
import { pickHugePages } from './pick-huge-pages';

test.each([
  {
    label: 'a fixed imp with huge pages on',
    isOn: true,
    memoryMib: 512,
    maxMemoryMib: 512,
    expected: '2M',
  },
  {
    label: 'a fixed imp with huge pages off',
    isOn: false,
    memoryMib: 512,
    maxMemoryMib: 512,
    expected: 'None',
  },
  {
    label: 'an elastic imp with huge pages on',
    isOn: true,
    memoryMib: 512,
    maxMemoryMib: 2048,
    expected: 'None',
  },
  {
    label: 'an imp of an odd MiB count with huge pages on',
    isOn: true,
    memoryMib: 513,
    maxMemoryMib: 513,
    expected: 'None',
  },
] as const)('it boots $label on $expected', (row) => {
  expect(pickHugePages(row.isOn, row)).toBe(row.expected);
});
