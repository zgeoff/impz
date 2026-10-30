import { createHash } from 'node:crypto';
import type { HostIdentity } from '../sleep/vm-identity';
import { BASE_BOOT_ARGS, VM_DEVICES } from '../vmm/configure-vm';
import type { HugePages } from '../vmm/firecracker-client';

export const TEMPLATE_BOOT_ARGS = [...BASE_BOOT_ARGS, 'imp.template=1'].join(' ');

export interface TemplateShape {
  readonly vcpus: number;
  readonly memoryMib: number;

  // the host's own pages when left out
  readonly hugePages?: HugePages;
}

export function buildTemplateKey(identity: Readonly<HostIdentity>, shape: Readonly<TemplateShape>) {
  const fields = {
    guestKernel: identity.guestKernel,
    systemDrive: identity.systemDrive,
    firecrackerVersion: identity.firecrackerVersion,
    snapshotVersion: identity.snapshotVersion,
    hostKernel: identity.hostKernel,

    // The guest kernel picks its code paths on the CPU it boots on, and a cloud host's CPU can
    // change at a reboot, which faults a restore.
    cpuModel: identity.cpuModel,
    cpuFlags: identity.cpuFlags,
    bootArgs: TEMPLATE_BOOT_ARGS,
    devices: VM_DEVICES,
    memoryMib: shape.memoryMib,
    vcpus: shape.vcpus,

    // a 4 KiB template keeps the key it had before guests could run on huge pages
    ...(shape.hugePages === '2M' && { hugePages: shape.hugePages }),
  };

  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}
