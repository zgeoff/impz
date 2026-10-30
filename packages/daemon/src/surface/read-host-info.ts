import type { SystemInfo } from '@impz/api';
import { UNKNOWN_CPU, parseCpuInfo } from '../vm/sleep/cpu-identity';
import type { HugePagePool } from '../vm/vmm/read-huge-page-pool';

export interface HostInfoSources {
  readonly isHugePages: boolean;
  readonly readKernel: () => string;
  readonly readCpuInfo: () => string;
  readonly readHugePagePool: () => HugePagePool | null;
  readonly readBootTemplateCount: (() => number) | null;
}

export function readHostInfo(sources: Readonly<HostInfoSources>): NonNullable<SystemInfo['host']> {
  const cpuInfo = readCpuInfoIfPresent(sources);

  return {
    kernel: sources.readKernel(),
    cpuModel: cpuInfo === null ? UNKNOWN_CPU : parseCpuInfo(cpuInfo).cpuModel,
    isNested: cpuInfo !== null && isNestedCpu(cpuInfo),
    hugePages: sources.isHugePages ? '2M' : 'off',
    hugePool: sources.readHugePagePool(),
    bootTemplates: sources.readBootTemplateCount?.() ?? null,
  };
}

function readCpuInfoIfPresent(sources: Readonly<HostInfoSources>): string | null {
  try {
    return sources.readCpuInfo();
  } catch {
    return null;
  }
}

// A CPU that runs under a hypervisor sets the `hypervisor` flag, so every guest
// impd boots on it is a nested VM.
/* @internal */
export function isNestedCpu(cpuInfo: string): boolean {
  return /^flags\s*:.*\bhypervisor\b/mu.test(cpuInfo);
}
