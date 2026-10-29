import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface FirecrackerPaths {
  readonly apiSocket: string;
  readonly vsockSocket: string;
  readonly logFile: string;
  readonly pidFile: string;
}

export interface ImpPaths extends FirecrackerPaths {
  readonly impId: string;
  readonly directory: string;
  readonly runDir: string;
  readonly uffdSocket: string;
  readonly uffdPidFile: string;
  readonly disk: string;
  readonly snapshotDir: string;
  readonly vmstate: string;
  readonly memFile: string;
  readonly snapshotMeta: string;

  // sits outside the snapshot directory, which a cold boot clears
  readonly vmIdentity: string;
  readonly checkpointsDir: string;
  readonly sessionLogsDir: string;
}

export interface ImagePaths {
  readonly directory: string;
  readonly rootfs: string;
  readonly config: string;
}

// A 2 MiB guest's page handler listens and records its pid in the run
// directory, beside its VM's sockets.
export const UFFD_RUN_FILES = { socket: 'uffd.sock', pidFile: 'uffd.pid' } as const;
const DATA_DIRS = ['db', 'system', 'images', 'imps'] as const;

export function createDataDirs(dataDir: string): void {
  for (const name of DATA_DIRS) {
    mkdirSync(join(dataDir, name), { recursive: true });
  }
}

export function buildImpsDir(dataDir: string): string {
  return join(dataDir, 'imps');
}

export function buildImagesDir(dataDir: string): string {
  return join(dataDir, 'images');
}

export function toDigestHex(digest: string): string {
  return digest.replace(/^sha256:/u, '');
}

export function buildImpPaths(dataDir: string, impId: string): ImpPaths {
  const directory = join(buildImpsDir(dataDir), impId);
  const runDir = join(directory, 'run');

  return {
    impId,
    directory,
    runDir,
    disk: join(directory, 'disk.ext4'),
    apiSocket: join(runDir, 'api.sock'),
    vsockSocket: join(runDir, 'vsock.sock'),
    logFile: join(runDir, 'firecracker.log'),
    pidFile: join(runDir, 'pid'),
    uffdSocket: join(runDir, UFFD_RUN_FILES.socket),
    uffdPidFile: join(runDir, UFFD_RUN_FILES.pidFile),
    ...buildSnapshotPaths(join(directory, 'snapshot')),
    vmIdentity: join(directory, 'vm.json'),
    checkpointsDir: join(directory, 'checkpoints'),
    sessionLogsDir: join(directory, 'session-logs'),
  };
}

export function buildWatchdogSlot(impDir: string): SnapshotPaths {
  return buildSnapshotPaths(join(impDir, 'watchdog'));
}

export type SnapshotPaths = Readonly<ReturnType<typeof buildSnapshotPaths>>;

export function buildSnapshotPaths(snapshotDir: string) {
  return {
    snapshotDir,
    vmstate: join(snapshotDir, 'vmstate'),
    memFile: join(snapshotDir, 'mem'),
    snapshotMeta: join(snapshotDir, 'meta.json'),
  };
}

export function buildImagePaths(dataDir: string, digest: string): ImagePaths {
  const directory = join(buildImagesDir(dataDir), toDigestHex(digest));

  return {
    directory,
    rootfs: join(directory, 'rootfs.ext4'),
    config: join(directory, 'config.json'),
  };
}

export function buildUploadsDir(dataDir: string): string {
  return join(dataDir, 'uploads');
}

export function buildSystemDrivesDir(dataDir: string): string {
  return join(dataDir, 'system', 'drives');
}

export function buildSystemDrivePath(dataDir: string, sha256: string): string {
  return join(buildSystemDrivesDir(dataDir), `${sha256}.squashfs`);
}

export function buildBackupPaths(dataDir: string) {
  const directory = join(dataDir, 'backup');

  return {
    directoryPath: directory,
    tree: join(directory, 'tree'),
    cache: join(directory, 'cache'),
    state: join(directory, 'state.json'),
    copies: join(directory, 'copies.json'),
    restoreDir: join(directory, 'restore'),
  };
}

export const BACKUP_TREE = {
  manifest: 'manifest.json',

  // alone in its directory, since restic restores a directory at a time
  database: join('database', 'impd.sqlite'),
  buildImpDir: (impId: string) => join('imps', impId),
  buildDisk: (impId: string) => join('imps', impId, 'disk', 'rootfs.ext4'),
  buildCheckpointDisk: (impId: string, checkpointId: string) =>
    join('imps', impId, 'checkpoints', checkpointId, 'rootfs.ext4'),
  buildImageDir: (digest: string) => join('images', toDigestHex(digest)),
};
