import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SlotAddress } from '../../host-net/net/addressing';
import { GATEWAY_IP6 } from '../../host-net/net/addressing6';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import type { ImpPaths } from '../../vm/storage/data-layout';
import type { ImpCgroup } from '../../vm/vmm/cpu-cgroups';
import type { HugePages } from '../../vm/vmm/firecracker-client';
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
  readonly hugePages: HugePages;

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
      : context.templates?.requestTemplate({
          vcpus: imp.vcpus,
          memoryMib: imp.memoryMib,
          hugePages: start.hugePages,
        });

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
    const restoredBefore = context.templates?.countRestored(template) ?? 0;

    try {
      const vm = await context.vms.loadTemplateVm({
        firecrackerBin: context.config.firecrackerBin,
        paths,
        vmstate: template.vmstate,
        memFile: template.memFile,
        hugePages: template.hugePages,
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

      getImpdLogger('imps')
        .with({ imp: imp.name })
        .info('restored boot template {key} as pid {pid} {timings}{guestSteps}', {
          key: template.key.slice(0, 12),
          pid: String(vm.pid),
          timings: formatTimings({ ...hostSteps, ...vm.timings }),
          guestSteps: formatGuestSteps(vm.guestSteps),
        });

      return vm;
    } catch (error) {
      if (disk.isFailed) {
        await diskBytes;
      }

      getImpdLogger('imps')
        .with({ imp: imp.name })
        .warning('boot template {key} failed, booting the kernel: {error}', {
          key: template.key.slice(0, 12),
          error: getErrorMessage(error),
        });

      const fault = error instanceof TemplateRestoreError ? error.fault : null;

      context.templates?.reportFailure(template, { fault, restoredBefore });
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
    hugePages: start.hugePages,
    dns: context.config.dns,
    cgroup,
    isIdentityReset: imp.isIdentityResetPending,
    jail: context.findJailUser(imp),
  });

  getImpdLogger('imps')
    .with({ imp: imp.name })
    .info('booted pid {pid} {timings}{guestSteps}', {
      pid: String(vm.pid),
      timings: formatTimings({ ...hostSteps, ...vm.timings }),
      guestSteps: formatGuestSteps(vm.guestSteps),
    });

  return vm;
}

function formatGuestSteps(steps: Readonly<Record<string, number>> | undefined): string {
  return steps === undefined || Object.keys(steps).length === 0
    ? ''
    : `; guest ${formatTimings(steps)}`;
}
