import { mkdirSync, rmSync } from 'node:fs';
import type { EgressPolicy, Imp, ImpKind } from '@impz/api';
import { listCheckpoints } from '../../platform/db/checkpoints';
import type { ImageRecord } from '../../platform/db/images';
import { requireTransition } from '../../platform/db/imp-transitions';
import {
  listImps,
  readImpByName,
  removeImp,
  updateImpDisk,
  updateImpSettings,
} from '../../platform/db/imps';
import type { ImpRecord } from '../../platform/db/imps';
import { buildInvalidStateError } from '../../platform/errors/impd-errors';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { isRamBudgetError } from '../../vm/imps-contract/ram-budget-error';
import { buildImagePaths } from '../../vm/storage/data-layout';
import { resolveMaxMemoryMib } from '../../vm/vmm/elastic-memory';
import { resolveCpuSettings } from './cpu-limit';
import { createImpRecord } from './create-imp-record';
import type { ImpContext, ImpGuest, ImpHost, ImpVms } from './imp-context';
import { MIB, buildDiskTooSmallError, growDiskFile, readFileBytes } from './imp-disk';
import type { ImpLeases } from './imp-leases';
import { checkLiveness } from './imp-liveness';
import { toLockedImp } from './imp-lock';
import type { ImpLock, LockedImp } from './imp-lock';
import type { ImpPresenter, ImpUrls } from './imp-presenter';
import type { ImpVmOps } from './imp-vm-ops';

interface CreateImpInput {
  readonly name?: string | undefined;
  readonly image?: string | undefined;
  readonly vcpus?: number | undefined;
  readonly memoryMib?: number | undefined;

  readonly maxMemoryMib?: number | undefined;
  readonly httpPort?: number | undefined;
  readonly policy?: EgressPolicy | undefined;
  readonly cpuLimit?: number | null | undefined;
  readonly cpuWeight?: number | undefined;

  readonly networkIds?: readonly string[] | undefined;

  readonly diskMib?: number | undefined;

  readonly prepareDisk?: (impId: string) => Promise<void>;

  readonly start?: boolean;

  readonly isIdentityResetPending?: boolean;

  readonly isBackedUp?: boolean | undefined;

  readonly id?: string;
  readonly moveState?: 'receiving';
  readonly slot?: number;
  readonly isDiskGrowPending?: boolean;

  readonly kind?: ImpKind;
}

interface DestroyOptions {
  readonly isMove?: boolean;
}

interface ImpUpdate {
  readonly cpuLimit?: number | null | undefined;
  readonly cpuWeight?: number | undefined;
  readonly vcpus?: number | undefined;
  readonly httpPort?: number | undefined;
}

export interface ImpCommands {
  readonly createImp: (input: CreateImpInput) => Promise<Imp>;
  readonly listImps: () => Promise<Imp[]>;
  readonly readImp: (name: string) => Promise<Imp>;
  readonly listImpRecords: () => Promise<ImpRecord[]>;
  readonly readImpRecord: (name: string) => Promise<ImpRecord | undefined>;
  readonly startImp: (name: string) => Promise<Imp>;

  readonly stopImp: (name: string, force?: boolean) => Promise<Imp>;
  readonly destroyImp: (name: string, options?: DestroyOptions) => Promise<void>;

  readonly destroyImpId: (id: string, kind?: ImpKind) => Promise<void>;
  readonly readUrls: (name: string) => Promise<ImpUrls>;

  readonly sleepImp: (name: string, force?: boolean) => Promise<Imp>;

  readonly wakeImp: (name: string, restartError?: boolean) => Promise<Imp>;

  readonly resizeDisk: (name: string, diskMib: number) => Promise<Imp>;

  // A memory snapshot fixes the vCPU count, so it changes only while the imp
  // is stopped.
  readonly updateImp: (name: string, change: ImpUpdate) => Promise<Imp>;
}

interface ImpCommandParts {
  readonly context: ImpContext;
  readonly lock: ImpLock;
  readonly ops: ImpVmOps;
  readonly presenter: ImpPresenter;
  readonly leases: Pick<ImpLeases, 'requireUnleased' | 'endForcedLeases'>;
}

export function createImpCommands(parts: ImpCommandParts): ImpCommands {
  const context = parts.context;
  const lock = parts.lock;
  const ops = parts.ops;
  const presenter = parts.presenter;
  const leases = parts.leases;

  const removeLockedImp = async (imp: LockedImp): Promise<void> => {
    const paths = context.findPaths(imp.id);

    if (imp.pid !== null) {
      await context.vms.stopVm(imp.pid, paths, false);
    }

    // A jail mount would keep a ZFS disk busy, so the jail goes before the disk.
    await context.cgroups.remove(imp.id);
    await context.vms.removeJail(paths);
    await context.taps.removeTap(context.findAddress(imp.slot).tap);
    await context.egress.releaseSlot(imp.slot);

    const checkpoints = await listCheckpoints(context.db, imp.id);

    await removeImpFiles(
      context,
      imp.id,
      checkpoints.map((checkpoint) => checkpoint.id),
    );

    context.admission?.release(imp.id);

    await removeImp(context.db, imp.id);
  };

  return {
    createImp: async (input) => {
      const received = performance.now();

      const image = await context.images.resolveImage(input.image);

      if (input.policy !== undefined) {
        context.egress.requirePolicy(input.policy);
      }

      const diskBytes = resolveDiskBytes(context, input, image);
      const memoryMib = input.memoryMib ?? context.config.defaultMemoryMib;
      const maxMemoryMib = resolveMaxMemoryMib(memoryMib, input.maxMemoryMib);
      const id = input.id ?? Bun.randomUUIDv7();

      // A template's disk holds its source's machine-id and SSH host keys.
      const isIdentityResetPending =
        input.isIdentityResetPending ?? (image.source === 'imp' && input.prepareDisk === undefined);

      const writeRecord = () =>
        createImpRecord(
          context,
          id,
          { ...input, memoryMib, maxMemoryMib, diskBytes, isIdentityResetPending },
          image,
        );

      await context.diskBudget.requireRoom(0);

      return lock.withNewImp(id, writeRecord, async (imp) => {
        const paths = context.findPaths(imp.id);

        context.sessionLogs.admitImp(imp.id);

        const started = performance.now();
        const recordMs = Math.round(started - received);

        try {
          // The slot's firewall is in place before anything can bring its tap up.
          await context.egress.addSlot(imp.slot);

          // A warm move's guest knows its gateway by the slot's MAC, and a tap
          // that a failed destroy left in the slot may have another MAC.
          if (input.slot !== undefined) {
            await context.taps.removeTap(context.findAddress(imp.slot).tap);
          }

          mkdirSync(paths.runDir, { recursive: true });
        } catch (error) {
          await ops.writeFailure(imp, error);

          throw error;
        }

        const timing = { cloneMs: 0, sizeMs: 0 };

        const createDiskCopy = async () => {
          await (
            input.prepareDisk ??
            ((impId) =>
              context.storage.createImpDisk(impId, { kind: 'image', digest: image.digest }))
          )(imp.id);

          timing.cloneMs = Math.round(performance.now() - started);

          context.log(`impd: ${imp.name}: disk cloned in ${String(timing.cloneMs)}ms`);
        };

        const growNewDisk = async () => {
          const sizeStarted = performance.now();
          const cloneBytes = readFileBytes(paths.disk);
          const sizedBytes = growDiskFile(paths.disk, diskBytes ?? 0);

          if (sizedBytes > cloneBytes) {
            await growStoppedFilesystem(context, imp.name, paths.disk);
          }

          const sized = await updateImpDisk(context.db, imp.id, {
            diskBytes: sizedBytes,
            isGrowPending: input.isDiskGrowPending === true,
          });

          timing.sizeMs = Math.round(performance.now() - sizeStarted);

          return sized;
        };

        const setupNewDisk = async () => {
          await createDiskCopy();

          return growNewDisk();
        };

        if (input.start === false) {
          try {
            await setupNewDisk();
          } catch (error) {
            await ops.writeFailure(imp, error);

            throw error;
          }

          const stopped = await ops.updateState(imp, { reason: 'stopped', state: 'stopped' });

          return presenter.readApi(stopped);
        }

        // A ZFS disk is a mount, which a jail prepared before the clone never sees.
        try {
          await createDiskCopy();
        } catch (error) {
          await ops.writeFailure(imp, error);

          throw error;
        }

        const sizing = growNewDisk();

        void Promise.allSettled([sizing]);

        try {
          const bootStarted = performance.now();

          const running = await ops.startNewImpVm(imp, sizing);

          const bootMs = Math.round(performance.now() - bootStarted);

          const presented = await presenter.readApi(running);

          const totalMs = Math.round(performance.now() - received);

          context.log(
            `impd: ${imp.name}: created in ${String(totalMs)}ms record=${String(recordMs)}ms clone=${String(timing.cloneMs)}ms size=${String(timing.sizeMs)}ms boot=${String(bootMs)}ms`,
          );

          return presented;
        } catch (error) {
          await Promise.allSettled([sizing]);

          if (isRamBudgetError(error)) {
            await removeImpFiles(context, imp.id, []);
            await removeImp(context.db, imp.id);
          }

          throw error;
        }
      });
    },

    listImps: async () => {
      const imps = await listImps(context.db);

      const fresh = await Promise.all(
        imps.map((imp) => checkLiveness(context, imp, !lock.isLocked(imp.id))),
      );

      return presenter.readApiList(fresh);
    },

    readImp: async (name) => {
      const imp = await lock.findImp(name);

      return presenter.readApi(imp);
    },

    listImpRecords: () => listImps(context.db),
    readImpRecord: (name) => readImpByName(context.db, name),

    startImp: (name) =>
      lock.withImp(name, async (imp) => {
        const running = await ops.requireRunningImp(imp);

        return presenter.readApi(running);
      }),

    stopImp: (name, force = false) =>
      lock.withImp(name, async (imp) => {
        if (imp.state === 'stopped') {
          return presenter.readApi(imp);
        }

        if (imp.state === 'creating') {
          throw buildInvalidStateError(imp.state, ['running', 'sleeping', 'error'], 'stop');
        }

        requireTransition(imp.state, 'stopped', 'stop');

        await leases.requireUnleased(imp, force);

        const stopped = await ops.stopImpVm(imp);

        const after =
          force && stopped.state === 'stopped' ? await leases.endForcedLeases(stopped) : stopped;

        return presenter.readApi(after);
      }),

    destroyImp: async (name, options = {}) => {
      await lock.withImp(name, removeLockedImp, options);
    },

    destroyImpId: async (id, kind) => {
      await lock.withImpId(id, async (imp) => {
        if (imp !== undefined && (kind === undefined || imp.kind === kind)) {
          await removeLockedImp(imp);
        }
      });
    },

    readUrls: async (name) => {
      const imp = await lock.findImp(name);

      return presenter.readUrls(imp);
    },

    sleepImp: (name, force = false) =>
      lock.withImp(name, async (imp) => {
        if (imp.state === 'sleeping') {
          return presenter.readApi(imp);
        }

        requireTransition(imp.state, 'sleeping', 'sleep');

        await leases.requireUnleased(imp, force);

        const asleep = await ops.sleepImpVm(imp, 'requested');

        const after =
          force && asleep.state === 'sleeping' ? await leases.endForcedLeases(asleep) : asleep;

        return presenter.readApi(after);
      }),

    wakeImp: (name, restartError = true) =>
      lock.withImp(name, async (imp) => {
        if (imp.state === 'error' && !restartError) {
          throw buildInvalidStateError(imp.state, ['running', 'sleeping', 'stopped'], 'wake');
        }

        const running = await ops.requireRunningImp(imp);

        return presenter.readApi(running);
      }),

    resizeDisk: (name, diskMib) =>
      lock.withImp(name, async (imp) => {
        if (imp.state === 'creating') {
          throw buildInvalidStateError(
            imp.state,
            ['running', 'sleeping', 'stopped', 'error'],
            'resize',
          );
        }

        const diskBytes = diskMib * MIB;

        if (diskBytes < imp.diskBytes) {
          throw buildDiskTooSmallError(diskBytes, imp.diskBytes, 'the disk now; a disk only grows');
        }

        if (diskBytes === imp.diskBytes) {
          return presenter.readApi(imp);
        }

        const paths = context.findPaths(imp.id);

        // The disk file is sparse, so the grow needs only room past the reserve.
        await context.diskBudget.requireRoom(0);

        growDiskFile(paths.disk, diskBytes);

        const updated = await updateImpDisk(context.db, imp.id, {
          diskBytes,
          isGrowPending: imp.state === 'sleeping',
        });

        const grown = toLockedImp(imp, updated);

        context.log(`impd: ${imp.name}: disk grown to ${String(diskMib)} MiB`);

        if (grown.pid === null && grown.state !== 'sleeping') {
          await growStoppedFilesystem(context, imp.name, paths.disk);
        }

        if (grown.state !== 'running') {
          return presenter.readApi(grown);
        }

        const resized = await ops.growGuestDisk(grown);

        return presenter.readApi(resized);
      }),

    updateImp: (name, change) =>
      lock.withImp(name, async (imp) => {
        const vcpus = change.vcpus ?? imp.vcpus;

        if (vcpus !== imp.vcpus && imp.state !== 'stopped') {
          throw buildInvalidStateError(imp.state, ['stopped'], 'change the vCPU count of');
        }

        const cpu = resolveCpuSettings(change, imp.cpu, context.hostCpus);

        const updated = await updateImpSettings(context.db, imp.id, {
          cpu,
          vcpus,
          httpPort: change.httpPort ?? imp.httpPort,
        });

        if (updated.state === 'running') {
          context.cgroups.apply(imp.id, cpu);
        }

        return presenter.readApi(toLockedImp(imp, updated));
      }),
  };
}

// On ZFS a dataset is mounted inside the imp's directory and rm -r fails on it,
// so the storage backend removes the disk first.
async function removeImpFiles(
  context: ImpVms & ImpGuest,
  impId: string,
  checkpointIds: readonly string[],
): Promise<void> {
  const paths = context.findPaths(impId);

  context.sessionLogs.forgetImp(impId);

  await context.storage.removeImpDisk(impId, checkpointIds);

  rmSync(paths.directory, { recursive: true, force: true });
  rmSync(paths.snapshotDir, { recursive: true, force: true });
}

function resolveDiskBytes(
  context: ImpHost,
  input: CreateImpInput,
  image: ImageRecord,
): number | undefined {
  const requested = input.diskMib === undefined ? undefined : input.diskMib * MIB;

  if (input.prepareDisk !== undefined) {
    return requested;
  }

  const floor = readFileBytes(buildImagePaths(context.config.dataDir, image.digest).rootfs);

  if (requested !== undefined && requested < floor) {
    const what =
      image.source === 'imp' ? `template ${image.name}'s disk` : "the image's filesystem";

    throw buildDiskTooSmallError(requested, floor, what);
  }

  return requested ?? Math.max(context.config.defaultDiskBytes, floor);
}

async function growStoppedFilesystem(context: ImpHost & ImpVms, name: string, disk: string) {
  try {
    const isGrown = await context.growFilesystem(disk);

    if (!isGrown) {
      context.log(`impd: ${name}: the filesystem was not unmounted cleanly; its boot grows it`);
    }
  } catch (error) {
    context.log(`impd: ${name}: the host could not grow the filesystem: ${getErrorMessage(error)}`);
  }
}
