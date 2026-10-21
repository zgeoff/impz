import { existsSync, readFileSync } from 'node:fs';
import { release } from 'node:os';
import type { OutdatedPart } from '@impz/api';
import * as z from 'zod';
import { writeFileDurably } from '../../platform/process/write-file-durably';
import type { ImpPaths } from '../storage/data-layout';
import type { SystemFiles } from '../storage/setup-system-files';
import { readCpuIdentity } from './cpu-identity';
import type { CpuIdentity } from './cpu-identity';

export const VmIdentitySchema = z.object({
  firecrackerVersion: z.string(),
  snapshotVersion: z.string(),
  hostKernel: z.string(),
  guestKernel: z.string(),
  systemDrive: z.string(),
  systemDrivePath: z.string(),
  agentVersion: z.string(),
  bootReason: z.string().nullable(),
  ipv6Prefix: z.string().nullable().optional(),
  cpuModel: z.string().optional(),
  cpuFlags: z.string().optional(),
});

export type VmIdentity = z.infer<typeof VmIdentitySchema>;

export type HostIdentity = Omit<VmIdentity, 'agentVersion' | 'bootReason'> & CpuIdentity;

export function readHostIdentity(
  firecrackerBin: string,
  systemFiles: Readonly<SystemFiles>,
  ipv6Prefix: string | null = null,
): HostIdentity {
  return {
    ...readCpuIdentity(),
    ipv6Prefix,
    firecrackerVersion: readVersionOutput(firecrackerBin, '--version'),
    snapshotVersion: readVersionOutput(firecrackerBin, '--snapshot-version'),
    hostKernel: release(),
    guestKernel: systemFiles.info.guestKernel.sha256,
    systemDrive: systemFiles.info.systemDrive.sha256,
    systemDrivePath: systemFiles.systemDrivePath,
  };
}

export function writeVmIdentity(paths: Readonly<ImpPaths>, identity: Readonly<VmIdentity>): void {
  writeFileDurably(paths.vmIdentity, `${JSON.stringify(identity, null, 2)}\n`);
}

export function readVmIdentity(paths: Readonly<ImpPaths>): VmIdentity | null {
  if (!existsSync(paths.vmIdentity)) {
    return null;
  }

  try {
    return VmIdentitySchema.parse(JSON.parse(readFileSync(paths.vmIdentity, 'utf8')));
  } catch {
    return null;
  }
}

type PartIdentity = Pick<
  HostIdentity,
  'firecrackerVersion' | 'guestKernel' | 'systemDrive' | 'ipv6Prefix'
>;

export function collectOutdatedParts(
  vm: Readonly<PartIdentity>,
  host: Readonly<PartIdentity>,
): OutdatedPart[] {
  const parts: [keyof Omit<PartIdentity, 'ipv6Prefix'>, OutdatedPart][] = [
    ['firecrackerVersion', 'firecracker'],
    ['guestKernel', 'kernel'],
    ['systemDrive', 'agent'],
  ];

  const outdated = parts.filter(([key]) => vm[key] !== host[key]).map(([, part]) => part);
  const hostPrefix = host.ipv6Prefix ?? null;

  return hostPrefix !== null && (vm.ipv6Prefix ?? null) !== hostPrefix
    ? [...outdated, 'ipv6']
    : outdated;
}

export const UNKNOWN_VERSION = 'unknown';

function readVersionOutput(bin: string, flag: string): string {
  try {
    const result = Bun.spawnSync([bin, flag], { stdout: 'pipe', stderr: 'ignore' });
    const match = /v\d+\.\d+\.\d+/u.exec(result.stdout.toString());

    return match?.[0] ?? UNKNOWN_VERSION;
  } catch {
    return UNKNOWN_VERSION;
  }
}
