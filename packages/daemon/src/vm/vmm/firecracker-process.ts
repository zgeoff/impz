import { closeSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { basename } from 'node:path';
import { IMPD_USER } from '../../platform/process/impd-user';
import { listPids, readStatFields, stopPid } from '../../platform/process/proc';
import { readRegularFile, setupLogFile, writeRegularFile } from '../files/vm-files';
import type { FirecrackerPaths } from '../storage/data-layout';
import { readProcessCgroup, readProcessUid } from './process-owner';

// a jailed process cannot change its uid or its cgroup, so ownership rests
// on those two alone
export interface VmOwner {
  readonly uid: number | null;
  readonly cgroup: string | null;
}

export interface FoundVm {
  readonly pid: number;
  readonly apiSocket: string;
  readonly owner: VmOwner;
}

export function isImpVm(owner: VmOwner, impId: string, jailUid: number | null): boolean {
  return (
    owner.uid === IMPD_USER.uid ||
    (jailUid !== null && owner.uid === jailUid) ||
    owner.cgroup === `/imps/${impId}`
  );
}

const SOCKET_WAIT_MS = 3000;

/* @internal */
export function buildSpawnArgv(
  command: readonly string[],
  cgroupProcs: string | null,
  mergeWrapper: string | null,
): string[] {
  // The KSM merge flag survives the jailer's setuid and exec, so `mergeWrapper` runs outside the
  // chroot, which needs no copy of it.
  const wrapped = mergeWrapper === null ? command : [mergeWrapper, ...command];

  if (cgroupProcs === null) {
    return ['setsid', ...wrapped];
  }

  return ['sh', '-c', 'echo $$ > "$1" && shift && exec setsid "$@"', 'sh', cgroupProcs, ...wrapped];
}

export async function startFirecracker(
  command: readonly string[],
  paths: Readonly<FirecrackerPaths>,
  cgroupProcs: string | null = null,
  mergeWrapper: string | null = null,
) {
  rmSync(paths.apiSocket, { force: true });
  rmSync(paths.vsockSocket, { force: true });

  const log = setupLogFile(paths.logFile);
  const argv = buildSpawnArgv(command, cgroupProcs, mergeWrapper);

  const child = Bun.spawn(argv, {
    stdin: 'ignore',
    stdout: log,
    stderr: log,
  });

  closeSync(log);

  child.unref();

  writeRegularFile(paths.pidFile, `${String(child.pid)}\n`);

  const deadline = Date.now() + SOCKET_WAIT_MS;

  while (!existsSync(paths.apiSocket)) {
    if (child.exitCode !== null || Date.now() > deadline) {
      stopPid(child.pid);

      throw new Error(
        `firecracker did not open its API socket (exit ${String(child.exitCode)}): ${readLogTail(paths.logFile)}`,
      );
    }

    await Bun.sleep(2);
  }

  return child.pid;
}

export function probeFirecrackerAlive(pid: number, apiSocket: string, procRoot = '/proc'): boolean {
  const state = readStatFields(pid, procRoot)?.[0];

  if (state === undefined || state === 'Z' || state === 'X') {
    return false;
  }

  try {
    const cmdline = readFileSync(`${procRoot}/${String(pid)}/cmdline`, 'utf8').split('\0');

    return cmdline.includes(apiSocket);
  } catch {
    return false;
  }
}

export async function waitForExit(
  pid: number,
  apiSocket: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (probeFirecrackerAlive(pid, apiSocket)) {
    if (Date.now() > deadline) {
      return false;
    }

    await Bun.sleep(10);
  }

  return true;
}

export function readLogTail(logFile: string, lines = 20): string {
  try {
    return readRegularFile(logFile).trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

export function readPidFile(pidFile: string): number | null {
  try {
    const pid = Number(readRegularFile(pidFile).trim());

    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function listFirecrackers(): FoundVm[] {
  const found: FoundVm[] = [];

  for (const pid of listPids()) {
    const argv = readCommandLine(pid);
    const flag = argv.indexOf('--api-sock');
    const apiSocket = argv[flag + 1];

    if (
      basename(argv[0] ?? '') === 'firecracker' &&
      flag !== -1 &&
      apiSocket !== undefined &&
      probeFirecrackerAlive(pid, apiSocket)
    ) {
      // A jailed process can put any socket in its command line, so only its owner shows whose VM
      // it is.
      found.push({ pid, apiSocket, owner: readVmOwner(pid) });
    }
  }

  return found;
}

export function readVmOwner(pid: number): VmOwner {
  return { uid: readProcessUid(pid), cgroup: readProcessCgroup(pid) };
}

function readCommandLine(pid: number): string[] {
  try {
    return readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').split('\0');
  } catch {
    return [];
  }
}

export function buildFirecrackerCommand(bin: string, apiSocket: string): readonly string[] {
  return [bin, '--api-sock', apiSocket];
}

export function probeJailedFirecracker(pid: number): boolean {
  try {
    // The jailer passes its --id on to the Firecracker it execs.
    return readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8')
      .split('\0')
      .includes('--id');
  } catch {
    return false;
  }
}
