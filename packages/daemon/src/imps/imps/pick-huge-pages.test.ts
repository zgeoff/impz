import { expect, test } from 'bun:test';
import { pickHugePages, readPageSettings } from './pick-huge-pages';

test.each([
  {
    label: 'a fixed imp with huge pages on',
    isOn: true,
    isElasticTransparent: true,
    memoryMib: 512,
    maxMemoryMib: 512,
    expected: '2M',
  },
  {
    label: 'a fixed imp with huge pages off',
    isOn: false,
    isElasticTransparent: true,
    memoryMib: 512,
    maxMemoryMib: 512,
    expected: 'None',
  },
  {
    label: 'an elastic imp with the pool on',
    isOn: true,
    isElasticTransparent: true,
    memoryMib: 512,
    maxMemoryMib: 2048,
    expected: 'Transparent',
  },
  {
    label: 'an elastic imp with the pool off',
    isOn: false,
    isElasticTransparent: true,
    memoryMib: 1024,
    maxMemoryMib: 2048,
    expected: 'Transparent',
  },
  {
    label: 'an elastic imp with the transparent setting off',
    isOn: true,
    isElasticTransparent: false,
    memoryMib: 512,
    maxMemoryMib: 2048,
    expected: 'None',
  },
  {
    label: 'a fixed imp of an odd MiB count with huge pages on',
    isOn: true,
    isElasticTransparent: true,
    memoryMib: 513,
    maxMemoryMib: 513,
    expected: 'None',
  },
  {
    label: 'an elastic imp of an odd MiB count',
    isOn: true,
    isElasticTransparent: true,
    memoryMib: 513,
    maxMemoryMib: 1026,
    expected: 'None',
  },
  {
    label: 'an elastic imp with an odd max memory',
    isOn: true,
    isElasticTransparent: true,
    memoryMib: 256,
    maxMemoryMib: 513,
    expected: 'None',
  },
] as const)('it boots $label on $expected', (row) => {
  expect(pickHugePages(row, row)).toBe(row.expected);
});

test.each([
  { isSet: true, isKernelAble: true, expected: true },
  { isSet: true, isKernelAble: false, expected: false },
  { isSet: false, isKernelAble: true, expected: false },
] as const)(
  '#readPageSettings asks for transparent huge pages with the setting $isSet and a kernel able $isKernelAble: $expected',
  (row) => {
    const settings = readPageSettings({
      config: { hugePages: null, isElasticTransparentHugePages: row.isSet },
      probeTransparentHugePages: () => row.isKernelAble,
    });

    expect(settings.isElasticTransparent).toBe(row.expected);
  },
);
