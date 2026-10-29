import { getImpdLogger } from '../../platform/process/get-impd-logger';
import type { ImpPaths } from '../storage/data-layout';
import type { HandlerState } from './uffd-handler';

export interface UffdWatchDeps {
  readonly probeVmAlive: (pid: number, paths: ImpPaths) => boolean;
  readonly readHandlerState: (paths: ImpPaths) => HandlerState;
  readonly stopPid: (pid: number) => void;

  // calls tick at an interval until the returned function stops it
  readonly startTimer: (tick: () => void) => () => void;
}

export interface UffdWatch {
  // stops the VM if its handler is already gone, and from then on when it goes
  readonly watch: (pid: number, paths: ImpPaths) => void;
}

interface WatchedVm {
  readonly pid: number;
  readonly paths: ImpPaths;
}

export function createUffdWatch(deps: Readonly<UffdWatchDeps>): UffdWatch {
  const watched = new Map<string, WatchedVm>();

  const timer: { stop: (() => void) | null } = { stop: null };

  const checkVms = (): void => {
    for (const [impId, vm] of watched) {
      if (!deps.probeVmAlive(vm.pid, vm.paths)) {
        watched.delete(impId);
      } else if (deps.readHandlerState(vm.paths).state === 'gone') {
        watched.delete(impId);
        deps.stopPid(vm.pid);

        getImpdLogger('memory').warning(
          'imp {impId}: its page handler is gone; stopped firecracker pid {pid}, which would wait on its next page fault',
          { impId, pid: String(vm.pid) },
        );
      }
    }

    if (watched.size === 0 && timer.stop !== null) {
      timer.stop();

      timer.stop = null;
    }
  };

  return {
    watch: (pid, paths) => {
      if (deps.readHandlerState(paths).state === 'none') {
        return;
      }

      watched.set(paths.impId, { pid, paths });

      timer.stop ??= deps.startTimer(checkVms);

      checkVms();
    },
  };
}
