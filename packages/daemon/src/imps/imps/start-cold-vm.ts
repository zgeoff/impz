import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SlotAddress } from '../../host-net/net/addressing';
import { GATEWAY_IP6 } from '../../host-net/net/addressing6';
import { getErrorMessage } from '../../platform/process/get-error-message';
import type { ImpPaths } from '../../vm/storage/data-layout';
import type { ImpCgroup } from '../../vm/vmm/cpu-cgroups';
import { TemplateRestoreError } from '../../vm/vmm/template-vm';
import type { StartedVm } from '../../vm/vmm/vm-runner';
import { formatTimings } from './format-timings';
import type { ImpHost, ImpVms } from './imp-context';
import type { LockedImp } from './imp-lock';

// The agent wants at least 32 bytes of seed for the guest's entropy pool.
const CLAIM_SEED_BYTES = 64;

interface ColdVmStart {
  readonly imp: LockedImp;
  readonly paths: ImpPaths;
  readonly address: SlotAddress;
  readonly cgroup: ImpCgroup | null;

  readonly hostSteps: Readonly<Record<string, number>>;
  readonly diskReady: Promise<unknown>;
}

export async function startColdVm(
  context: ImpHost & ImpVms,
  start: Readonly<ColdVmStart>,
): Promise<StartedVm> {
  const imp = start.imp;
  const paths = start.paths;
  const address = start.address;
  const cgroup = start.cgroup;
  const hostSteps = start.hostSteps;

  // A template has no hot-plug region, so an elastic imp boots the kernel.
  const template =
    imp.maxMemoryMib > imp.memoryMib
      ? null
      : context.templates?.requestTemplate({ vcpus: imp.vcpus, memoryMib: imp.memoryMib });

  const disk = { isFailed: false };

  const readDiskBytes = async () => {
    try {
      await start.diskReady;
    } catch (error) {
      disk.isFailed = true;
      throw error;
    }

    return statSync(paths.disk).size;
  };

  const diskBytes = readDiskBytes();

  void Promise.allSettled([diskBytes]);

  if (template !== null && template !== undefined) {
    try {
      const vm = await context.vms.loadTemplateVm({
        firecrackerBin: context.config.firecrackerBin,
        paths,
        vmstate: template.vmstate,
        memFile: template.memFile,
        systemDrivePath: template.systemDrivePath,
        placeholderPath: template.placeholderPath,
        jail: context.findJailUser(imp),
        diskPath: resolve(paths.disk),
        tap: address.tap,
        cgroup,
        diskReady: diskBytes,
        claim: {
          id: imp.id,
          hostname: imp.name,
          ip: `${address.guestIp}/${String(address.prefixLength)}`,
          gw: address.hostIp,
          ip6: address.guestIp6 === null ? null : `${address.guestIp6}/128`,
          gw6: address.guestIp6 === null ? null : GATEWAY_IP6,
          dns: context.config.dns,
          mac: address.guestMac,
          seed: randomBytes(CLAIM_SEED_BYTES),
          isIdentityReset: imp.isIdentityResetPending,
        },
      });

      context.templates?.reportRestored(template);

      context.log(
        `impd: ${imp.name}: restored boot template ${template.key.slice(0, 12)} as pid ${String(vm.pid)} ${formatTimings({ ...hostSteps, ...vm.timings })}${formatGuestSteps(vm.guestSteps)}`,
      );

      return vm;
    } catch (error) {
      if (disk.isFailed) {
        await diskBytes;
      }

      context.log(
        `impd: ${imp.name}: boot template ${template.key.slice(0, 12)} failed, booting the kernel: ${getErrorMessage(error)}`,
      );

      const isTemplateFault = error instanceof TemplateRestoreError && error.isTemplateFault;

      context.templates?.reportFailure(template, isTemplateFault);
    }
  }

  await diskBytes;

  const vm = await context.vms.startVm({
    firecrackerBin: context.config.firecrackerBin,
    kernelPath: context.config.kernelPath,
    systemDrivePath: context.identity.systemDrivePath,
    paths,
    address,
    impId: imp.id,
    hostname: imp.name,
    vcpus: imp.vcpus,
    memoryMib: imp.memoryMib,
    maxMemoryMib: imp.maxMemoryMib,
    dns: context.config.dns,
    cgroup,
    isIdentityReset: imp.isIdentityResetPending,
    jail: context.findJailUser(imp),
  });

  context.log(
    `impd: ${imp.name}: booted pid ${String(vm.pid)} ${formatTimings({ ...hostSteps, ...vm.timings })}${formatGuestSteps(vm.guestSteps)}`,
  );

  return vm;
}

function formatGuestSteps(steps: Readonly<Record<string, number>> | undefined): string {
  return steps === undefined || Object.keys(steps).length === 0
    ? ''
    : `; guest ${formatTimings(steps)}`;
}
