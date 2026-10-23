import * as z from 'zod';
import { requireSocket } from '../files/vm-files';

const InstanceInfoSchema = z.object({ state: z.enum(['Not started', 'Running', 'Paused']) });

export type InstanceState = z.infer<typeof InstanceInfoSchema>['state'];

// Firecracker leaves the field out for a VM that does not track dirty pages
const MachineConfigSchema = z.object({ track_dirty_pages: z.boolean().optional() });

interface BootSource {
  readonly kernelImagePath: string;
  readonly bootArgs: string;
}

interface MachineConfig {
  readonly vcpuCount: number;
  readonly memSizeMib: number;
}

interface Drive {
  readonly driveId: string;
  readonly pathOnHost: string;
  readonly isRootDevice: boolean;
  readonly isReadOnly: boolean;
}

interface NetworkInterface {
  readonly ifaceId: string;
  readonly hostDevName: string;
  readonly guestMac: string;
}

interface Vsock {
  readonly guestCid: number;
  readonly udsPath: string;
}

interface Balloon {
  readonly amountMib: number;
  readonly deflateOnOom: boolean;
  readonly statsPollingIntervalS: number;
  readonly freePageReporting: boolean;
}

interface HotplugMemory {
  readonly totalSizeMib: number;
  readonly slotSizeMib: number;
  readonly blockSizeMib: number;
}

export interface HotplugState {
  // an unplug the guest cannot finish leaves plugged above requested
  readonly pluggedMib: number;
  readonly requestedMib: number;
}

interface BalloonStats {
  readonly totalMib: number;
  readonly availableMib: number;
}

// a Diff writes only the pages dirtied since the load, so its mem file must
// already hold the rest
export type SnapshotType = 'Full' | 'Diff';

interface SnapshotFiles {
  readonly snapshotPath: string;
  readonly memFilePath: string;
}

interface SnapshotOverrides {
  readonly ifaceId: string;
  readonly hostDevName: string;
  readonly vsockPath: string;
}

interface LoadOptions {
  readonly resumeVm: boolean;
  readonly overrides?: SnapshotOverrides;
  readonly isTrackingDirtyPages?: boolean;
}

interface MachineState {
  readonly isTrackingDirtyPages: boolean;
}

export interface FirecrackerClient {
  readonly putBootSource: (source: BootSource) => Promise<void>;
  readonly putMachineConfig: (config: MachineConfig) => Promise<void>;
  readonly loadMachineConfig: () => Promise<MachineState>;
  readonly putDrive: (drive: Drive) => Promise<void>;
  readonly patchDrive: (driveId: string, pathOnHost: string) => Promise<void>;
  readonly putNetworkInterface: (iface: NetworkInterface) => Promise<void>;
  readonly putVsock: (vsock: Vsock) => Promise<void>;

  // Firecracker accepts a balloon or a hotplug region only before
  // InstanceStart, never on a running or restored VM
  readonly putBalloon: (balloon: Balloon) => Promise<void>;
  readonly readBalloonStats: () => Promise<BalloonStats>;
  readonly putHotplugMemory: (hotplug: HotplugMemory) => Promise<void>;
  readonly readHotplugMemory: () => Promise<HotplugState>;
  readonly patchHotplugMemory: (requestedMib: number) => Promise<void>;
  readonly instanceStart: () => Promise<void>;
  readonly pause: () => Promise<void>;
  readonly resume: () => Promise<void>;

  // Firecracker snapshots only a paused VM, and a Diff only from a VM that
  // tracks its dirty pages
  readonly createSnapshot: (files: SnapshotFiles, type: SnapshotType) => Promise<void>;

  // Firecracker loads a snapshot only on a fresh process, before any other
  // configuration
  readonly loadSnapshot: (files: SnapshotFiles, options: LoadOptions) => Promise<void>;
  readonly readVersion: () => Promise<string>;
  readonly readInstanceState: () => Promise<InstanceState>;
}

interface FirecrackerTimeouts {
  readonly requestMs: number;
  readonly snapshotMs: number;
}

// A wedged Firecracker must not hold an imp's lock forever. A snapshot writes
// the whole guest memory, so it gets longer.
const DEFAULT_TIMEOUTS: FirecrackerTimeouts = { requestMs: 10_000, snapshotMs: 120_000 };

class FirecrackerApiError extends Error {
  readonly status: number;

  constructor(method: string, path: string, status: number, body: string) {
    super(`firecracker ${method} ${path}: ${String(status)} ${body}`);

    this.name = 'FirecrackerApiError';
    this.status = status;
  }
}

export function createFirecrackerClient(
  socketPath: string,
  timeouts: FirecrackerTimeouts = DEFAULT_TIMEOUTS,
): FirecrackerClient {
  const sendRequest = async (
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = timeouts.requestMs,
  ): Promise<string> => {
    requireSocket(socketPath);

    const init: BunFetchRequestInit = {
      method,
      unix: socketPath,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    };

    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    try {
      const response = await fetch(`http://localhost${path}`, init);
      const text = await response.text();

      if (!response.ok) {
        throw new FirecrackerApiError(method, path, response.status, text);
      }

      return text;
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new Error(`firecracker ${method} ${path}: no answer within ${String(timeoutMs)} ms`, {
          cause: error,
        });
      }

      throw error;
    }
  };

  const sendPut = async (path: string, body: unknown, timeoutMs?: number): Promise<void> => {
    await sendRequest('PUT', path, body, timeoutMs);
  };

  return {
    putBootSource: (source) =>
      sendPut('/boot-source', {
        kernel_image_path: source.kernelImagePath,
        boot_args: source.bootArgs,
      }),
    putMachineConfig: (config) =>
      sendPut('/machine-config', { vcpu_count: config.vcpuCount, mem_size_mib: config.memSizeMib }),
    loadMachineConfig: async () => {
      const text = await sendRequest('GET', '/machine-config');

      const parsed = MachineConfigSchema.parse(JSON.parse(text));

      return { isTrackingDirtyPages: parsed.track_dirty_pages === true };
    },
    putDrive: (drive) =>
      sendPut(`/drives/${drive.driveId}`, {
        drive_id: drive.driveId,
        path_on_host: drive.pathOnHost,
        is_root_device: drive.isRootDevice,
        is_read_only: drive.isReadOnly,
      }),
    patchDrive: async (driveId, pathOnHost) => {
      await sendRequest('PATCH', `/drives/${driveId}`, {
        drive_id: driveId,
        path_on_host: pathOnHost,
      });
    },
    putNetworkInterface: (iface) =>
      sendPut(`/network-interfaces/${iface.ifaceId}`, {
        iface_id: iface.ifaceId,
        host_dev_name: iface.hostDevName,
        guest_mac: iface.guestMac,
      }),
    putVsock: (vsock) => sendPut('/vsock', { guest_cid: vsock.guestCid, uds_path: vsock.udsPath }),
    putBalloon: (balloon) =>
      sendPut('/balloon', {
        amount_mib: balloon.amountMib,
        deflate_on_oom: balloon.deflateOnOom,
        stats_polling_interval_s: balloon.statsPollingIntervalS,
        free_page_reporting: balloon.freePageReporting,
      }),
    readBalloonStats: async () => {
      const text = await sendRequest('GET', '/balloon/statistics');

      const parsed = parseObject('GET /balloon/statistics', text);

      return {
        totalMib: readBytesAsMib(parsed, 'total_memory'),
        availableMib: readBytesAsMib(parsed, 'available_memory'),
      };
    },
    putHotplugMemory: (hotplug) =>
      sendPut('/hotplug/memory', {
        total_size_mib: hotplug.totalSizeMib,
        slot_size_mib: hotplug.slotSizeMib,
        block_size_mib: hotplug.blockSizeMib,
      }),
    readHotplugMemory: async () => {
      const text = await sendRequest('GET', '/hotplug/memory');

      const parsed = parseObject('GET /hotplug/memory', text);

      return {
        pluggedMib: readNumber(parsed, 'plugged_size_mib'),
        requestedMib: readNumber(parsed, 'requested_size_mib'),
      };
    },
    patchHotplugMemory: async (requestedMib) => {
      await sendRequest('PATCH', '/hotplug/memory', { requested_size_mib: requestedMib });
    },
    instanceStart: () => sendPut('/actions', { action_type: 'InstanceStart' }),
    pause: async () => {
      await sendRequest('PATCH', '/vm', { state: 'Paused' });
    },
    resume: async () => {
      await sendRequest('PATCH', '/vm', { state: 'Resumed' });
    },
    createSnapshot: (files, type) =>
      sendPut(
        '/snapshot/create',
        {
          snapshot_type: type,
          snapshot_path: files.snapshotPath,
          mem_file_path: files.memFilePath,
          sync_snapshot_files: true,
        },
        timeouts.snapshotMs,
      ),
    loadSnapshot: (files, options) =>
      sendPut(
        '/snapshot/load',
        {
          snapshot_path: files.snapshotPath,
          mem_backend: { backend_type: 'File', backend_path: files.memFilePath },
          resume_vm: options.resumeVm,
          ...(options.isTrackingDirtyPages === true && { track_dirty_pages: true }),
          ...(options.overrides !== undefined && {
            network_overrides: [
              { iface_id: options.overrides.ifaceId, host_dev_name: options.overrides.hostDevName },
            ],
            vsock_override: { uds_path: options.overrides.vsockPath },
          }),
        },
        timeouts.snapshotMs,
      ),
    readVersion: async () => {
      const text = await sendRequest('GET', '/version');

      const parsed: unknown = JSON.parse(text);

      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'firecracker_version' in parsed &&
        typeof parsed.firecracker_version === 'string'
      ) {
        return parsed.firecracker_version;
      }

      throw new Error(`firecracker GET /version: unexpected body ${text}`);
    },
    readInstanceState: async () => {
      const text = await sendRequest('GET', '/');

      return InstanceInfoSchema.parse(JSON.parse(text)).state;
    },
  };
}

function parseObject(call: string, text: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(text);

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`firecracker ${call}: unexpected body ${text}`);
  }

  return Object.fromEntries(Object.entries(parsed));
}

function readBytesAsMib(parsed: Readonly<Record<string, unknown>>, key: string): number {
  return Math.floor(readNumber(parsed, key) / 1_048_576);
}

function readNumber(parsed: Readonly<Record<string, unknown>>, key: string): number {
  const value = parsed[key];

  if (typeof value !== 'number') {
    throw new TypeError(`firecracker: no number ${key} in ${JSON.stringify(parsed)}`);
  }

  return value;
}
