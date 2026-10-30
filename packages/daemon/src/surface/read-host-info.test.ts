import { expect, test } from 'bun:test';
import { isNestedCpu, readHostInfo } from './read-host-info';

test('it reads the kernel, the CPU, its nesting, the pool and the boot templates', () => {
  const info = readHostInfo({
    isHugePages: true,
    readKernel: () => '6.12.40-imp',
    readCpuInfo: () =>
      'processor\t: 0\nmodel name\t: AMD EPYC 7763 64-Core Processor\nflags\t\t: fpu vmx hypervisor lm\n',
    readHugePagePool: () => ({ totalMib: 1024, freeMib: 512 }),
    readBootTemplateCount: () => 3,
  });

  expect(info).toStrictEqual({
    kernel: '6.12.40-imp',
    cpuModel: 'AMD EPYC 7763 64-Core Processor',
    isNested: true,
    hugePages: '2M',
    hugePool: { totalMib: 1024, freeMib: 512 },
    bootTemplates: 3,
  });
});

test('it reads no boot templates when impd keeps none, and no pool the host lacks', () => {
  const info = readHostInfo({
    isHugePages: false,
    readKernel: () => '6.1.0-arm',
    readCpuInfo: () => 'model name\t: Ampere Altra\nflags\t\t: fp asimd\n',
    readHugePagePool: () => null,
    readBootTemplateCount: null,
  });

  expect(info).toMatchObject({ hugePages: 'off', hugePool: null, bootTemplates: null });
});

test('it reads a host it cannot read the CPU of as not nested', () => {
  const info = readHostInfo({
    isHugePages: false,
    readKernel: () => '6.1.0-arm',
    readCpuInfo: () => {
      throw new Error('ENOENT: no such file or directory');
    },
    readHugePagePool: () => null,
    readBootTemplateCount: null,
  });

  expect(info).toMatchObject({ cpuModel: 'unknown', isNested: false });
});

test.each([
  ['a guest of a hypervisor', 'flags\t\t: fpu vmx hypervisor lm', true],
  ['bare metal', 'flags\t\t: fpu vmx lm', false],
  ['a flag that only holds the word', 'flags\t\t: fpu hypervisor_x lm', false],
])('#isNestedCpu reads %s', (_, cpuInfo, isNested) => {
  expect(isNestedCpu(cpuInfo)).toBe(isNested);
});
