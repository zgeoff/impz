import { readFileSync } from 'node:fs';
import { release } from 'node:os';
import type { SystemInfo } from '@impz/api';
import { readCpuIdentity } from '../vm/sleep/cpu-identity';
import type { HugePagePool } from '../vm/vmm/read-huge-page-pool';

export interface HostInfoSources {
  readonly isHugePages: boolean;
  readonly readHugePagePool: () => HugePagePool | null;
  readonly readBootTemplateCount: (() => number) | null;
  readonly cpuInfoPath?: string;
}

export function readHostInfo(sources: Readonly<HostInfoSources>): NonNullable<SystemInfo['host']> {
  const cpuInfoPath = sources.cpuInfoPath ?? '/proc/cpuinfo';

  return {
    kernel: release(),
    cpuModel: readCpuIdentity(cpuInfoPath).cpuModel,
    isNested: readIsNested(cpuInfoPath),
    hugePages: sources.isHugePages ? '2M' : 'off',
    hugePool: sources.readHugePagePool(),
    bootTemplates: sources.readBootTemplateCount?.() ?? null,
  };
}

// A CPU that runs under a hypervisor sets the `hypervisor` flag, so every guest
// impd boots on it is a nested VM.
function readIsNested(cpuInfoPath: string): boolean {
  try {
    return isNestedCpu(readFileSync(cpuInfoPath, 'utf8'));
  } catch {
    return false;
  }
}

/* @internal */
export function isNestedCpu(cpuInfo: string): boolean {
  return /^flags\s*:.*\bhypervisor\b/mu.test(cpuInfo);
}
