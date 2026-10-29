import { closeSync, existsSync, openSync, rmSync } from 'node:fs';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import { stopPid } from '../../platform/process/proc';
import { setupLogFile, writeRegularFile } from '../files/vm-files';
import type { ImpPaths } from '../storage/data-layout';
import type { ImpCgroup } from './cpu-cgroups';
import { buildSpawnArgv, probeProcessAlive, readLogTail, readPidFile } from './firecracker-process';
import type { JailUser } from './jail';

// the descriptor the handler reads the memory file from, which outlives the
// file's name
const MEM_FILE_FD = 3;
const SOCKET_WAIT_MS = 3000;
const WATCH_INTERVAL_MS = 100;

export interface UffdHandlerPlan {
  readonly handlerBin: string;
  readonly paths: ImpPaths;
  readonly memFile: string;
  readonly jail: JailUser | null;
  readonly cgroup: ImpCgroup | null;
}

export async function startUffdHandler(plan: Readonly<UffdHandlerPlan>): Promise<number> {
  const paths = plan.paths;

  removeUffdFiles(paths);

  const command = [
    plan.handlerBin,
    '--socket',
    paths.uffdSocket,
    ...(plan.jail === null ? [] : ['--uid', String(plan.jail.uid), '--gid', String(plan.jail.gid)]),
  ];

  const memFd = openSync(plan.memFile, 'r');
  const log = setupLogFile(paths.logFile);

  const child = Bun.spawn(buildSpawnArgv(command, plan.cgroup?.procsPath ?? null, null), {
    stdio: ['ignore', log, log, memFd],
  });

  closeSync(memFd);
  closeSync(log);

  child.unref();

  writeRegularFile(paths.uffdPidFile, `${String(child.pid)}\n`);

  const deadline = Date.now() + SOCKET_WAIT_MS;

  while (!existsSync(paths.uffdSocket)) {
    if (child.exitCode !== null || Date.now() > deadline) {
      stopPid(child.pid);

      throw new Error(
        `the page handler did not open its socket (exit ${String(child.exitCode)}): ${readLogTail(paths.logFile, 5)}`,
      );
    }

    await Bun.sleep(2);
  }

  return child.pid;
}

export function removeUffdFiles(paths: Readonly<ImpPaths>): void {
  rmSync(paths.uffdSocket, { force: true });
  rmSync(`${paths.uffdSocket}.new`, { force: true });
  rmSync(paths.uffdPidFile, { force: true });
}

export type HandlerState =
  | { readonly state: 'none' }
  | { readonly state: 'alive'; readonly pid: number }
  | { readonly state: 'gone'; readonly pid: number | null };

// A VM with no pid file has no handler: it booted cold, or restored from its
// memory file. One whose handler is gone waits on its next fault forever.
export function readHandlerState(paths: Readonly<ImpPaths>, procRoot = '/proc'): HandlerState {
  if (!existsSync(paths.uffdPidFile)) {
    return { state: 'none' };
  }

  const pid = readPidFile(paths.uffdPidFile);

  return pid !== null && probeProcessAlive(pid, paths.uffdSocket, procRoot)
    ? { state: 'alive', pid }
    : { state: 'gone', pid };
}

// The handler holds the memory file it serves open, and a sleep copies the
// file through it after the file's name is gone, such as a removed template's.
export function buildServedFilePath(handlerPid: number, procRoot = '/proc'): string {
  return `${procRoot}/${String(handlerPid)}/fd/${String(MEM_FILE_FD)}`;
}

export function stopUffdHandler(paths: Readonly<ImpPaths>, procRoot = '/proc'): void {
  const handler = readHandlerState(paths, procRoot);

  if (handler.state === 'alive') {
    stopPid(handler.pid);
  }
}

interface WatchedVm {
  readonly pid: number;
  readonly paths: ImpPaths;
}

export interface UffdWatch {
  // stops the VM if its handler is already gone, and from then on when it goes
  readonly watch: (pid: number, paths: ImpPaths) => void;
}

export function createUffdWatch(procRoot = '/proc', intervalMs = WATCH_INTERVAL_MS): UffdWatch {
  const watched = new Map<string, WatchedVm>();

  const timer: { current: ReturnType<typeof setInterval> | null } = { current: null };

  const checkVms = (): void => {
    for (const [impId, vm] of watched) {
      if (!probeProcessAlive(vm.pid, vm.paths.apiSocket, procRoot)) {
        watched.delete(impId);
      } else if (readHandlerState(vm.paths, procRoot).state === 'gone') {
        watched.delete(impId);

        stopPid(vm.pid);

        getImpdLogger('memory').warning(
          'imp {impId}: its page handler is gone; stopped firecracker pid {pid}, which would wait on its next page fault',
          { impId, pid: String(vm.pid) },
        );
      }
    }

    if (watched.size === 0 && timer.current !== null) {
      clearInterval(timer.current);

      timer.current = null;
    }
  };

  return {
    watch: (pid, paths) => {
      if (readHandlerState(paths, procRoot).state === 'none') {
        return;
      }

      watched.set(paths.impId, { pid, paths });

      if (timer.current === null) {
        timer.current = setInterval(checkVms, intervalMs);

        timer.current.unref();
      }

      checkVms();
    },
  };
}

export function requireHandlerBin(handlerBin: string | null): string {
  if (handlerBin === null) {
    throw new Error(
      'a 2 MiB snapshot restores only through the page handler, and IMP_HUGE_PAGES is off',
    );
  }

  return handlerBin;
}

// A load that waits on a page its handler never serves fails as a lost API
// connection, which names nothing that went wrong.
export function explainUffdFailure(
  paths: Readonly<ImpPaths>,
  procRoot: string,
  reason: string,
): string {
  return readHandlerState(paths, procRoot).state === 'gone'
    ? `its page handler exited (${reason})`
    : reason;
}
