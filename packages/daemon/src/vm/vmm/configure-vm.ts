import type { FirecrackerClient } from './firecracker-client';

export function createMarks() {
  const marks: Record<string, number> = {};
  let last = performance.now();

  const setMark = (step: string): void => {
    const now = performance.now();

    marks[step] = Math.round(now - last);
    last = now;
  };

  return { marks, setMark };
}

interface VmConfig {
  readonly kernelPath: string;
  readonly bootArgs: string;
  readonly vcpus: number;
  readonly memoryMib: number;
  readonly diskPath: string;
  readonly systemDrivePath: string;
  readonly vsockPath: string;
  readonly tap: string;
  readonly guestMac: string;
}

export const BASE_BOOT_ARGS = [
  'console=ttyS0 reboot=k panic=1 pci=off',
  'i8042.noaux i8042.nomux i8042.nopnp i8042.dumbkbd',
  'root=/dev/vdb rootfstype=squashfs ro init=/imp-agent',
] as const;

export const VM_DEVICES = {
  drives: { rootfs: 'rootfs', system: 'system' },
  vsockCid: 3,
  iface: 'eth0',
  balloon: {
    amountMib: 0,
    deflateOnOom: true,
    statsPollingIntervalS: 1,
    freePageReporting: true,
  },
} as const;

// a template restore takes the snapshot's devices, so a cold boot and a
// template build must configure the same ones
export async function setupVm(
  api: Readonly<FirecrackerClient>,
  config: Readonly<VmConfig>,
): Promise<void> {
  await api.putBootSource({ kernelImagePath: config.kernelPath, bootArgs: config.bootArgs });
  await api.putMachineConfig({ vcpuCount: config.vcpus, memSizeMib: config.memoryMib });

  // drives enumerate in PUT order: rootfs is vda, the system drive vdb;
  // neither is a Firecracker root device, which would add root=/dev/vda
  await api.putDrive({
    driveId: VM_DEVICES.drives.rootfs,
    pathOnHost: config.diskPath,
    isRootDevice: false,
    isReadOnly: false,
  });

  await api.putDrive({
    driveId: VM_DEVICES.drives.system,
    pathOnHost: config.systemDrivePath,
    isRootDevice: false,
    isReadOnly: true,
  });

  await api.putVsock({ guestCid: VM_DEVICES.vsockCid, udsPath: config.vsockPath });

  await api.putNetworkInterface({
    ifaceId: VM_DEVICES.iface,
    hostDevName: config.tap,
    guestMac: config.guestMac,
  });

  await api.putBalloon(VM_DEVICES.balloon);
}
