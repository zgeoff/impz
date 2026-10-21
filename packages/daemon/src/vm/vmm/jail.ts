import {
  chmodSync,
  closeSync,
  existsSync,
  lchownSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { IMPD_USER } from '../../platform/process/impd-user';
import { parseMounts, readMounts as readHostMounts } from '../../platform/process/mounts';
import { listPids, readStatFields } from '../../platform/process/proc';
import type { CommandRunner } from '../../platform/process/run-command';
import type { ImpPaths } from '../storage/data-layout';
import type { FirecrackerPaths } from './firecracker-process';
import { probeProcessOfUid, stopProcessOfUid } from './process-owner';
import { writeRegularFile } from './vm-files';

export interface JailUser {
  readonly uid: number;
  readonly gid: number;
}

interface JailPlan {
  readonly impId: string;
  readonly user: JailUser;
  readonly paths: ImpPaths;
  readonly readOnlyFiles: readonly string[];
  readonly scratchFiles?: readonly string[];
  readonly isDiskLate?: boolean;
}

interface BuildJailPlan {
  readonly id: string;
  readonly user: JailUser;
  readonly workDir: string;
  readonly paths: RunPaths;
  readonly readOnlyFiles: readonly string[];
  readonly scratchFiles: readonly string[];
}

export interface RunPaths extends FirecrackerPaths {
  readonly runDir: string;
}

export interface Jails {
  readonly prepare: (plan: Readonly<JailPlan>) => Promise<readonly string[]>;
  readonly prepareBuild: (plan: Readonly<BuildJailPlan>) => Promise<readonly string[]>;
  readonly setupDiskOwner: (paths: ImpPaths, user: Readonly<JailUser>) => void;
  readonly release: (impId: string) => Promise<void>;
  readonly sweepRunDir: (paths: ImpPaths) => Promise<void>;
  readonly remove: (impId: string) => Promise<void>;
  readonly removeOrphans: (impIds: ReadonlySet<string>) => Promise<string[]>;

  // a stray entry in run/ means a compromised VM: the seal throws without
  // deleting anything while the VM runs, and the caller must kill the VM
  readonly seal: (paths: RunPaths, pid: number) => void;
}

interface ChrootPlan {
  readonly id: string;
  readonly user: JailUser;
  readonly dirs: readonly string[];
  readonly readOnlyFiles: readonly string[];
  readonly scratchFiles: readonly string[];
  readonly apiSocket: string;
  readonly setupFiles: () => void;
}

export interface JailDeps {
  readonly jailerBin: string;

  // an absolute path, because the jailer copies it into each chroot
  readonly firecrackerBin: string;
  readonly chrootBase: string;
  readonly run: CommandRunner;
  readonly readMounts?: () => string;
  readonly log: (message: string) => void;
  readonly killCgroup?: (impId: string) => void;
  readonly listUidPids?: (uid: number) => readonly number[];
  readonly killUidPid?: (pid: number, uid: number) => void;
  readonly isPidExiting?: (pid: number) => boolean;
  readonly readRootOwner?: (root: string) => number | undefined;
  readonly wait?: (durationMs: number) => Promise<void>;
}

const KILL_WAIT_MS = 20;
const KILL_TRIES = 50;

// A killed Firecracker frees its guest's memory before it leaves /proc, and
// keeps the jail uid while it does: seconds for a guest of many GiB.
const EXIT_TRIES = 3000;

export function createJails(deps: Readonly<JailDeps>): Jails {
  const execName = basename(deps.firecrackerBin);
  const getJailDir = (impId: string): string => join(deps.chrootBase, execName, impId);
  const getRoot = (impId: string): string => join(getJailDir(impId), 'root');
  const readMounts = deps.readMounts ?? readHostMounts;
  const listUidPids = deps.listUidPids ?? listProcessesOfUid;
  const killUidPid = deps.killUidPid ?? stopProcessOfUid;
  const isPidExiting = deps.isPidExiting ?? probeProcessExiting;
  const readRootOwner = deps.readRootOwner ?? readOwnerUid;
  const wait = deps.wait ?? Bun.sleep;

  // Nothing of the jail's uid may outlive its Firecracker: root deletes,
  // unmounts and chowns in the jail next, and the uid goes to the next imp.
  const stopJailProcesses = async (impId: string, uid: number): Promise<void> => {
    if (uid === IMPD_USER.uid) {
      return;
    }

    deps.killCgroup?.(impId);

    for (let attempt = 1; ; attempt += 1) {
      const pids = listUidPids(uid);

      if (pids.length === 0) {
        return;
      }

      const tries = pids.every((pid) => isPidExiting(pid)) ? EXIT_TRIES : KILL_TRIES;

      if (attempt > tries) {
        throw new Error(`jail ${impId}: uid ${String(uid)} still runs processes`);
      }

      for (const pid of pids) {
        killUidPid(pid, uid);
      }

      await wait(KILL_WAIT_MS);
    }
  };

  const runMount = async (argv: readonly string[]): Promise<void> => {
    const result = await deps.run(argv);

    if (result.exitCode !== 0) {
      throw new Error(`${argv.join(' ')}: ${result.stderr.trim()}`);
    }
  };

  const removeMounts = async (impId: string): Promise<void> => {
    const owner = readRootOwner(getRoot(impId));

    if (owner !== undefined) {
      await stopJailProcesses(impId, owner);
    }

    const mounted = listMountsUnder(readMounts(), getRoot(impId)).toReversed();

    for (const target of mounted) {
      const result = await deps.run(['umount', target]);

      if (result.exitCode !== 0) {
        await runMount(['umount', '--lazy', target]);
      }
    }
  };

  const remove = async (impId: string): Promise<void> => {
    await removeMounts(impId);

    if (listMountsUnder(readMounts(), getRoot(impId)).length === 0) {
      rmSync(getJailDir(impId), { recursive: true, force: true });
    }
  };

  // `=recursive` sets nosuid and nodev on every submount and keeps their other
  // flags, such as ro; it needs mount_setattr, from util-linux 2.39
  const setupDirBind = async (source: string, target: string): Promise<void> => {
    mkdirSync(target, { recursive: true });

    await runMount(['mount', '--rbind', '-o', 'nosuid=recursive,nodev=recursive', source, target]);
  };

  const setupReadOnlyBind = async (source: string, target: string): Promise<void> => {
    mkdirSync(dirname(target), { recursive: true });
    closeSync(openSync(target, 'a'));

    await runMount(['mount', '--bind', source, target]);
    await runMount(['mount', '-o', 'remount,bind,ro,nosuid,nodev', target]);
  };

  const setupChroot = async (chroot: Readonly<ChrootPlan>): Promise<readonly string[]> => {
    const root = getRoot(chroot.id);

    await stopJailProcesses(chroot.id, chroot.user.uid);
    await removeMounts(chroot.id);

    // a recursive delete crosses into bind mounts and would reach the imp's
    // own files
    if (listMountsUnder(readMounts(), root).length > 0) {
      throw new Error(`jail ${chroot.id}: ${root} still has mounts`);
    }

    chroot.setupFiles();

    // the last VM owned the chroot and may have left symlinks in it, so a
    // fresh chroot keeps the mkdir and mounts below from following them
    rmSync(getJailDir(chroot.id), { recursive: true, force: true });
    mkdirSync(root, { recursive: true });

    // a private mount of its own, so mount propagation carries no bind below
    // it out to the host or in from it
    await runMount(['mount', '--bind', root, root]);
    await runMount(['mount', '--make-private', root]);

    for (const directory of chroot.dirs) {
      await setupDirBind(directory, join(root, directory));
    }

    for (const file of chroot.readOnlyFiles) {
      await setupReadOnlyBind(file, join(root, file));
    }

    for (const file of chroot.scratchFiles) {
      if (chroot.dirs.some((directory) => file.startsWith(`${directory}/`))) {
        throw new Error(`jail ${chroot.id}: ${file} is inside a bound directory`);
      }

      setupScratchFile(file, join(root, file), chroot.user);
    }

    await runMount(['mount', '--make-rprivate', root]);

    return buildJailerCommand({
      jailerBin: deps.jailerBin,
      firecrackerBin: deps.firecrackerBin,
      chrootBase: deps.chrootBase,
      impId: chroot.id,
      user: chroot.user,
      apiSocket: chroot.apiSocket,
    });
  };

  return {
    prepare: (plan) =>
      setupChroot({
        id: plan.impId,
        user: plan.user,
        dirs: listBoundDirs(plan.paths),
        readOnlyFiles: plan.readOnlyFiles,
        scratchFiles: plan.scratchFiles ?? [],
        apiSocket: plan.paths.apiSocket,
        setupFiles: () => {
          setupOwnership(plan.paths, plan.user, plan.isDiskLate ?? false);
        },
      }),
    prepareBuild: (plan) =>
      setupChroot({
        id: plan.id,
        user: plan.user,
        dirs: [plan.workDir],
        readOnlyFiles: plan.readOnlyFiles,
        scratchFiles: plan.scratchFiles,
        apiSocket: plan.paths.apiSocket,
        setupFiles: () => {
          setupImpdRunDir(plan.paths);
          lchownSync(plan.paths.runDir, plan.user.uid, plan.user.gid);
        },
      }),
    setupDiskOwner: (paths, user) => {
      requireRegularFile(paths.disk);
      lchownSync(paths.disk, user.uid, user.gid);
    },
    release: removeMounts,
    sweepRunDir: async (paths) => {
      // the jail's processes stop before the recursive delete, which one still
      // running could race
      await removeMounts(paths.impId);

      setupImpdRunDir(paths);
    },
    remove,
    removeOrphans: async (impIds) => {
      const base = join(deps.chrootBase, execName);
      const ids = existsSync(base) ? readdirSync(base) : [];
      const orphans = ids.filter((impId) => !impIds.has(impId));
      const removed: string[] = [];

      for (const impId of orphans) {
        try {
          await remove(impId);

          removed.push(impId);
        } catch (error) {
          deps.log(`impd: jail ${impId}: ${getErrorMessage(error)}`);
        }
      }

      return removed;
    },
    seal: (paths, pid) => {
      // the chown comes first, so the VM cannot add to run/ while it is read
      setupImpdDir(paths.runDir);

      const planted = readdirSync(paths.runDir).filter(
        (name) => !probeSealedEntry(paths, join(paths.runDir, name)),
      );

      if (planted.length > 0) {
        throw new Error(
          `${paths.runDir}: the VM left ${planted.join(', ')} there; a VM that writes there is compromised`,
        );
      }

      writeRegularFile(paths.pidFile, `${String(pid)}\n`);
    },
  };
}

interface JailerCommand {
  readonly jailerBin: string;
  readonly firecrackerBin: string;
  readonly chrootBase: string;
  readonly impId: string;
  readonly user: JailUser;
  readonly apiSocket: string;
}

export function buildJailerCommand(command: Readonly<JailerCommand>): readonly string[] {
  // impd places the VM in its cgroup itself, so the jailer gets no --cgroup.
  return [
    command.jailerBin,
    '--id',
    command.impId,
    '--exec-file',
    command.firecrackerBin,
    '--uid',
    String(command.user.uid),
    '--gid',
    String(command.user.gid),
    '--chroot-base-dir',
    command.chrootBase,
    '--',
    '--api-sock',
    command.apiSocket,
  ];
}

export function listBoundDirs(paths: Readonly<ImpPaths>): readonly string[] {
  const isInside = paths.snapshotDir.startsWith(`${paths.directory}/`);

  return isInside ? [paths.directory] : [paths.directory, paths.snapshotDir];
}

export function listMountsUnder(mounts: string, root: string): string[] {
  return parseMounts(mounts)
    .map((mount) => mount.target)
    .filter((target) => target === root || target.startsWith(`${root}/`))
    .toSorted((left, right) => left.split('/').length - right.split('/').length);
}

// Directories stay impd's, so the VM can write into a file but never replace
// one with a symlink or a FIFO that impd then opens as root.
function setupOwnership(
  paths: Readonly<ImpPaths>,
  user: Readonly<JailUser>,
  isDiskLate: boolean,
): void {
  setupImpdRunDir(paths);
  lchownSync(paths.runDir, user.uid, user.gid);
  setupImpdDir(paths.snapshotDir);

  for (const file of [paths.vmstate, paths.memFile]) {
    if (existsSync(file)) {
      requireRegularFile(file);
    }
  }

  if (!isDiskLate) {
    requireRegularFile(paths.disk);
    lchownSync(paths.disk, user.uid, user.gid);
  }

  for (const file of [paths.vmstate, paths.memFile]) {
    if (existsSync(file)) {
      setupSnapshotFile(file, user.gid);
    }
  }
}

// The placeholder takes the host file's size, because the snapshot recorded
// that size for the drive.
function setupScratchFile(source: string, target: string, user: Readonly<JailUser>): void {
  mkdirSync(dirname(target), { recursive: true });
  closeSync(openSync(target, 'wx', 0o600));
  truncateSync(target, statSync(source).size);
  lchownSync(target, user.uid, user.gid);
}

function requireRegularFile(file: string): void {
  if (!lstatSync(file).isFile()) {
    throw new Error(`${file} is not a regular file`);
  }
}

// Call only once nothing of the jail's uid runs, because the delete recurses
// into whatever the VM left.
function setupImpdRunDir(paths: Readonly<RunPaths>): void {
  setupImpdDir(paths.runDir);

  for (const name of readdirSync(paths.runDir)) {
    const path = join(paths.runDir, name);

    if (!probeSealedEntry(paths, path)) {
      rmSync(path, { recursive: true, force: true });
    }
  }
}

function probeSealedEntry(paths: Readonly<RunPaths>, path: string): boolean {
  const entry = lstatSync(path);

  if (path === paths.apiSocket || path === paths.vsockSocket) {
    return entry.isSocket();
  }

  return (
    (path === paths.logFile || path === paths.pidFile) &&
    entry.isFile() &&
    entry.uid === IMPD_USER.uid &&
    entry.nlink === 1
  );
}

function setupImpdDir(directory: string): void {
  setupRealDir(directory);
  lchownSync(directory, IMPD_USER.uid, IMPD_USER.gid);
  chmodSync(directory, 0o755);
}

export function setupTemplateFile(file: string): void {
  const entry = lstatSync(file);

  if (!entry.isFile() || entry.nlink !== 1) {
    throw new Error(`${file} is not a regular file with one name`);
  }

  lchownSync(file, IMPD_USER.uid, IMPD_USER.gid);
  chmodSync(file, 0o644);
}

export function setupSnapshotFile(file: string, gid: number): void {
  lchownSync(file, IMPD_USER.uid, gid);
  chmodSync(file, 0o640);
}

function setupRealDir(directory: string): void {
  const found = lstatSync(directory, { throwIfNoEntry: false });

  if (found !== undefined && !found.isDirectory()) {
    rmSync(directory, { force: true });
  }

  mkdirSync(directory, { recursive: true });
}

function listProcessesOfUid(uid: number): number[] {
  return listPids().filter((pid) => probeProcessOfUid(pid, uid));
}

// the kernel's PF_EXITING, which a task sets as it starts to exit
const PF_EXITING = 0x4;

// /proc/<pid>/stat holds the task's flags in its 9th field.
function probeProcessExiting(pid: number): boolean {
  const fields = readStatFields(pid);

  if (fields === null) {
    return true;
  }

  const [state] = fields;
  const flags = Number(fields[6]);

  return state === 'Z' || state === 'X' || (flags & PF_EXITING) !== 0;
}

function readOwnerUid(path: string): number | undefined {
  return lstatSync(path, { throwIfNoEntry: false })?.uid;
}
