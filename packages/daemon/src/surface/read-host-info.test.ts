import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNestedCpu, readHostInfo } from './read-host-info';

async function setupTest() {
  const directory = await mkdtemp(join(tmpdir(), 'impd-host-info-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return { cpuInfoPath: join(directory, 'cpuinfo') };
}

test('it reads the kernel, the CPU, its nesting, the pool and the boot templates', async () => {
  const ctx = await setupTest();

  await writeFile(
    ctx.cpuInfoPath,
    'processor\t: 0\nmodel name\t: AMD EPYC 7763 64-Core Processor\nflags\t\t: fpu vmx hypervisor lm\n',
  );

  const info = readHostInfo({
    isHugePages: true,
    readHugePagePool: () => ({ totalMib: 1024, freeMib: 512 }),
    readBootTemplateCount: () => 3,
    cpuInfoPath: ctx.cpuInfoPath,
  });

  expect(info).toStrictEqual({
    kernel: release(),
    cpuModel: 'AMD EPYC 7763 64-Core Processor',
    isNested: true,
    hugePages: '2M',
    hugePool: { totalMib: 1024, freeMib: 512 },
    bootTemplates: 3,
  });
});

test('it reads no boot templates when impd keeps none, and no pool the host lacks', async () => {
  const ctx = await setupTest();

  await writeFile(ctx.cpuInfoPath, 'model name\t: Ampere Altra\nflags\t\t: fp asimd\n');

  const info = readHostInfo({
    isHugePages: false,
    readHugePagePool: () => null,
    readBootTemplateCount: null,
    cpuInfoPath: ctx.cpuInfoPath,
  });

  expect(info).toMatchObject({ hugePages: 'off', hugePool: null, bootTemplates: null });
});

test('it reads a host it cannot read the CPU of as not nested', () => {
  const info = readHostInfo({
    isHugePages: false,
    readHugePagePool: () => null,
    readBootTemplateCount: null,
    cpuInfoPath: '/nonexistent/cpuinfo',
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
