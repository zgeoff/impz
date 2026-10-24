import { rmSync } from 'node:fs';
import { writeUnknownBoot } from '../../platform/db/cold-boots';
import { updateImpActivity } from '../../platform/db/imps';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import {
  readLoadingMeta,
  readSnapshotMeta,
  removeSnapshot,
  removeSnapshotMeta,
  resetSnapshotLoading,
} from '../../vm/sleep/snapshot-meta';
import { buildImpPaths, buildImpsDir, buildWatchdogSlot } from '../../vm/storage/data-layout';
import type { ImpPaths } from '../../vm/storage/data-layout';
import { isImpVm } from '../../vm/vmm/firecracker-process';
import type { ImpHost, ImpMemory, ImpVms } from './imp-context';
import type { LockedImp } from './imp-lock';
import type { ImpVmOps } from './imp-vm-ops';

export interface VmReconciler {
  readonly reconcileImp: (imp: LockedImp) => Promise<LockedImp>;

  readonly killUnknownVms: (ids: ReadonlySet<string>) => Promise<void>;
}

// Firecracker answers nothing on GET / while it loads a large snapshot.
const STATE_WAIT_MS = 10_000;
const STATE_RETRY_MS = 250;

export function createVmReconciler(
  context: ImpHost & ImpVms & ImpMemory,
  ops: ImpVmOps,
): VmReconciler {
  const readVmStateWithin = async (paths: ImpPaths) => {
    const deadline = Date.now() + STATE_WAIT_MS;

    for (;;) {
      const state = await context.vms.readVmState(paths);

      if (state !== null || Date.now() >= deadline) {
        return state;
      }

      await Bun.sleep(STATE_RETRY_MS);
    }
  };

  // impd can die before a start writes its pid file, and a retried start
  // leaves two VMs, so the socket's processes count as well.
  const readVms = (imp: LockedImp, paths: ImpPaths): number[] => {
    const pids = new Set(
      context.vms
        .listVms()
        .filter((vm) => vm.apiSocket === paths.apiSocket && isImpVm(vm.owner, imp.id, imp.jailUid))
        .map((vm) => vm.pid),
    );

    const filed = context.vms.readPid(paths);

    if (
      filed !== null &&
      context.vms.probeVmAlive(filed, paths) &&
      isImpVm(context.vms.readVmOwner(filed), imp.id, imp.jailUid)
    ) {
      pids.add(filed);
    }

    return [...pids].toSorted((left, right) => left - right);
  };

  const stopOrphan = async (name: string, pid: number, paths: ImpPaths): Promise<boolean> => {
    try {
      await context.vms.stopVm(pid, paths, false);

      getImpdLogger('imps')
        .with({ imp: name })
        .info('killed firecracker pid {pid}, which no record owns', { pid: String(pid) });

      return true;
    } catch (error) {
      getImpdLogger('imps')
        .with({ imp: name })
        .warning('could not kill pid {pid}: {error}', {
          pid: String(pid),
          error: getErrorMessage(error),
        });

      return false;
    }
  };

  const wakeOrphan = async (imp: LockedImp, paths: ImpPaths, pid: number): Promise<LockedImp> => {
    const state = await readVmStateWithin(paths);

    const loading = readLoadingMeta(paths);

    // The guest never ran, so its disk is as the snapshot left it.
    if (state === 'Not started') {
      await stopOrphan(imp.name, pid, paths);

      if (loading !== null) {
        resetSnapshotLoading(paths);
      }

      return imp;
    }

    const meta = loading ?? readSnapshotMeta(paths);

    try {
      if (state === null) {
        throw new Error('its API does not answer');
      }

      if (state === 'Paused') {
        await context.vms.resumeVm(pid, paths);
      }

      await context.admission?.admit({
        id: imp.id,
        name: imp.name,
        reserveMib: Math.max(meta?.ramMib ?? 0, context.config.wakeReserveMib),
        memoryMib: imp.maxMemoryMib,
      });

      const woken = await context.vms.finishWake(paths);

      if (meta?.agentVersion !== undefined && woken.agentVersion !== meta.agentVersion) {
        throw new Error(`the agent answered as ${woken.agentVersion}, not ${meta.agentVersion}`);
      }

      getImpdLogger('imps')
        .with({ imp: imp.name })
        .info('adopted firecracker pid {pid}, which a wake left', { pid: String(pid) });

      await updateImpActivity(context.db, imp.id, new Date());

      if (woken.bootId !== undefined) {
        await writeUnknownBoot(context.db, imp.id, woken.bootId, new Date());
      }

      const running = await ops.updateState(imp, {
        reason: 'adopted',
        state: 'running',
        pid,
        error: null,
        sleptAt: null,
        firecrackerVersion: woken.firecrackerVersion,
      });

      removeSnapshotMeta(paths);

      return running;
    } catch (error) {
      getImpdLogger('imps')
        .with({ imp: imp.name })
        .warning('cannot adopt the VM a wake left: {error}; it boots cold next', {
          error: getErrorMessage(error),
        });

      context.admission?.release(imp.id);
      removeSnapshot(paths);

      if (!(await stopOrphan(imp.name, pid, paths))) {
        return ops.updateState(imp, {
          reason: 'failed',
          state: 'error',
          pid,
          error: 'could not stop a VM a wake left',
        });
      }

      return ops.updateState(imp, {
        reason: 'repaired',
        state: 'stopped',
        pid: null,
        nextBootCause: 'wake_fallback',
      });
    }
  };

  const checkPaused = async (imp: LockedImp, paths: ImpPaths): Promise<void> => {
    if (imp.pid === null || (await context.vms.readVmState(paths)) !== 'Paused') {
      return;
    }

    try {
      await context.vms.resumeVm(imp.pid, paths);

      getImpdLogger('imps').with({ imp: imp.name }).info('resumed the VM a cut sleep left paused');
    } catch (error) {
      getImpdLogger('imps')
        .with({ imp: imp.name })
        .warning('could not resume its paused VM: {error}', { error: getErrorMessage(error) });
    }
  };

  return {
    reconcileImp: async (imp) => {
      const paths = context.findPaths(imp.id);

      removePartialFiles(paths);

      const owned = imp.state === 'sleeping' || imp.state === 'stopped' ? null : imp.pid;
      const orphans = readVms(imp, paths).filter((pid) => pid !== owned);
      const [only] = orphans;

      if (imp.state === 'sleeping' && only !== undefined && orphans.length === 1) {
        return wakeOrphan(imp, paths, only);
      }

      for (const pid of orphans) {
        await stopOrphan(imp.name, pid, paths);
      }

      if (imp.state === 'sleeping' && orphans.length > 1) {
        removeSnapshot(paths);

        return ops.updateState(imp, {
          reason: 'repaired',
          state: 'stopped',
          pid: null,
          nextBootCause: 'wake_fallback',
        });
      }

      if (imp.state === 'sleeping' && readLoadingMeta(paths) !== null) {
        getImpdLogger('imps')
          .with({ imp: imp.name })
          .info('a wake was cut and its VM is gone; it boots cold next');

        removeSnapshot(paths);

        return ops.updateState(imp, {
          reason: 'repaired',
          state: 'stopped',
          pid: null,
          nextBootCause: 'wake_fallback',
        });
      }

      if (imp.state === 'running') {
        await checkPaused(imp, paths);
      }

      return imp;
    },

    killUnknownVms: async (ids) => {
      const dataDir = context.config.dataDir;

      for (const vm of context.vms.listVms()) {
        const id = parseImpId(dataDir, vm.apiSocket);

        if (id !== null && !ids.has(id) && isImpVm(vm.owner, id, null)) {
          await stopOrphan(id, vm.pid, buildImpPaths(dataDir, id));
        }
      }
    },
  };
}

function removePartialFiles(paths: ImpPaths): void {
  const slot = buildWatchdogSlot(paths.directory);

  for (const path of [
    paths.vmstate,
    paths.memFile,
    paths.snapshotMeta,
    paths.vmIdentity,
    slot.vmstate,
    slot.memFile,
    slot.snapshotMeta,
  ]) {
    rmSync(`${path}.new`, { force: true });
  }
}

function parseImpId(dataDir: string, apiSocket: string): string | null {
  const prefix = `${buildImpsDir(dataDir)}/`;

  if (!apiSocket.startsWith(prefix)) {
    return null;
  }

  const [id = ''] = apiSocket.slice(prefix.length).split('/');

  return id !== '' && buildImpPaths(dataDir, id).apiSocket === apiSocket ? id : null;
}
