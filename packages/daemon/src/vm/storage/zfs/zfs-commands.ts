import { parseMounts } from '../../../platform/process/mounts';
import { runChecked } from '../../../platform/process/run-command';
import type { CommandRunner } from '../../../platform/process/run-command';

export interface ZfsEntry {
  readonly name: string;
  readonly type: 'filesystem' | 'snapshot';
  readonly origin: string | null;

  // ZFS destroys a snapshot that `zfs destroy -d` marked together with its last clone.
  readonly deferDestroy: boolean;
}

interface MountOptions {
  readonly isReadOnly: boolean;
}

export interface ZfsCommands {
  readonly list: (root: string) => Promise<ZfsEntry[]>;
  readonly create: (name: string, properties?: Readonly<Record<string, string>>) => Promise<void>;
  readonly snapshot: (name: string) => Promise<void>;
  readonly clone: (
    snapshot: string,
    target: string,
    properties?: Readonly<Record<string, string>>,
  ) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly promote: (name: string) => Promise<void>;
  readonly destroy: (name: string) => Promise<void>;
  readonly destroyDeferred: (snapshot: string) => Promise<void>;
  readonly destroyRecursive: (name: string) => Promise<void>;
  readonly estimateSend: (snapshot: string, base: string | null) => Promise<number>;
  readonly readWritten: (snapshot: string) => Promise<number>;
  readonly readUsage: (name: string) => Promise<{ used: number; available: number }>;
  readonly listSpace: (root: string) => Promise<ZfsSpace[]>;
  readonly readVersion: () => Promise<string>;

  // A legacy ZFS mount ignores the readonly property, so a read-only mount passes `ro` itself.
  readonly mount: (name: string, directory: string, options?: MountOptions) => Promise<void>;
  readonly unmount: (directory: string) => Promise<void>;
}

const LIST_COLUMNS = 'name,type,origin,defer_destroy';
const SPACE_COLUMNS = 'name,used,referenced,usedbydataset,creation,clones';

// ZFS counts a dataset's snapshots in its `used`, and a snapshot's `used` holds only the blocks it
// alone holds. A snapshot has no usedbydataset.
export interface ZfsSpace {
  readonly name: string;
  readonly used: number;
  readonly referenced: number;
  readonly usedByDataset: number;

  // `zfs list -p` gives `creation` in seconds since the epoch.
  readonly createdAt: Date | null;
  readonly clones: readonly string[];
}

export function createZfsCommands(run: CommandRunner): ZfsCommands {
  const readStdout = (argv: readonly string[]): Promise<string> =>
    runChecked(argv, {}, (command) => run(command));

  const runQuiet = async (argv: readonly string[]): Promise<void> => {
    await readStdout(argv);
  };

  return {
    list: async (root) => {
      const stdout = await readStdout([
        'zfs',
        'list',
        '-Hp',
        '-r',
        '-t',
        'filesystem,snapshot',
        '-s',
        'createtxg',
        '-o',
        LIST_COLUMNS,
        root,
      ]);

      return parseZfsList(stdout);
    },
    create: (name, properties = {}) =>
      runQuiet(['zfs', 'create', ...buildPropertyArgs(properties), name]),
    snapshot: (name) => runQuiet(['zfs', 'snapshot', name]),
    clone: (snapshot, target, properties = {}) =>
      runQuiet(['zfs', 'clone', ...buildPropertyArgs(properties), snapshot, target]),
    rename: (from, to) => runQuiet(['zfs', 'rename', from, to]),
    promote: (name) => runQuiet(['zfs', 'promote', name]),
    destroy: (name) => runQuiet(['zfs', 'destroy', name]),
    destroyDeferred: (snapshot) => runQuiet(['zfs', 'destroy', '-d', snapshot]),
    destroyRecursive: (name) => runQuiet(['zfs', 'destroy', '-r', name]),
    estimateSend: async (snapshot, base) => {
      const stdout = await readStdout(['zfs', 'send', '-nP', ...buildSendArgs(snapshot, base)]);

      return parseSendSize(stdout);
    },
    readWritten: async (snapshot) => {
      const stdout = await readStdout(['zfs', 'get', '-Hp', '-o', 'value', 'written', snapshot]);

      return parseBytes(stdout.trim());
    },
    readUsage: async (name) => {
      const stdout = await readStdout(['zfs', 'list', '-Hp', '-o', 'used,available', name]);

      const [used = '', available = ''] = stdout.trim().split('\t');

      return { used: parseBytes(used), available: parseBytes(available) };
    },
    listSpace: async (root) => {
      const stdout = await readStdout([
        'zfs',
        'list',
        '-Hp',
        '-r',
        '-t',
        'filesystem,snapshot',
        '-o',
        SPACE_COLUMNS,
        root,
      ]);

      return parseZfsSpace(stdout);
    },
    readVersion: async () => {
      const stdout = await readStdout(['zfs', 'version']);

      return parseZfsVersion(stdout);
    },
    mount: (name, directory, options) =>
      runQuiet([
        'mount',
        '-t',
        'zfs',
        ...(options?.isReadOnly === true ? ['-o', 'ro'] : []),
        name,
        directory,
      ]),
    unmount: (directory) => runQuiet(['umount', directory]),
  };
}

function buildSendArgs(snapshot: string, base: string | null): string[] {
  return base === null ? [snapshot] : ['-i', base, snapshot];
}

export function buildSendArgv(snapshot: string, base: string | null): string[] {
  return ['zfs', 'send', ...buildSendArgs(snapshot, base)];
}

export function buildReceiveArgv(target: string, origin: string | null): string[] {
  // A clone stream names its origin, because the source's guid alone could match the source's own
  // snapshot in the same pool.
  return ['zfs', 'recv', '-u', ...(origin === null ? [] : ['-o', `origin=${origin}`]), target];
}

export function parseSendSize(stdout: string): number {
  // `zfs send -nP` ends with `size\t<bytes>`
  const line = stdout.split('\n').find((row) => row.startsWith('size\t'));

  if (line === undefined) {
    throw new Error(`zfs send -nP: no size in ${JSON.stringify(stdout.trim())}`);
  }

  return parseBytes(line.slice('size\t'.length).trim());
}

export function parseZfsSpace(stdout: string): ZfsSpace[] {
  return stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [
        name = '',
        used = '',
        referenced = '',
        usedByDataset = '',
        creation = '',
        clones = '',
      ] = line.split('\t');

      return {
        name,
        used: parseBytes(used),
        referenced: parseBytes(referenced),
        usedByDataset: usedByDataset === '-' ? 0 : parseBytes(usedByDataset),
        createdAt: parseEpochSeconds(creation),
        clones: clones === '-' || clones === '' ? [] : clones.split(','),
      };
    });
}

function buildPropertyArgs(properties: Readonly<Record<string, string>>): string[] {
  return Object.entries(properties).flatMap(([key, value]) => ['-o', `${key}=${value}`]);
}

export function parseZfsList(stdout: string): ZfsEntry[] {
  return stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [name = '', type = '', origin = '-', deferDestroy = '-'] = line.split('\t');

      if (type !== 'filesystem' && type !== 'snapshot') {
        throw new Error(`zfs list: unexpected row ${JSON.stringify(line)}`);
      }

      return {
        name,
        type,
        origin: origin === '-' || origin === '' ? null : origin,
        deferDestroy: deferDestroy === 'on',
      };
    });
}

export function parseZfsVersion(stdout: string): string {
  // `zfs version` prints the userland first (zfs-2.2.2-0ubuntu9), then the kernel module
  // (zfs-kmod-2.2.2-0ubuntu9).
  const userland = /^zfs-(?<version>\d+\.\d+\S*)$/mu.exec(stdout);
  const version = userland?.groups?.['version'];

  if (version === undefined) {
    throw new Error(`zfs version: unexpected output ${JSON.stringify(stdout.trim())}`);
  }

  return version;
}

export function parseZfsRelease(version: string): { major: string; minor: string } {
  const found = /^(?<major>\d+)\.(?<minor>\d+)/u.exec(version.trim())?.groups;

  return { major: found?.['major'] ?? version.trim(), minor: found?.['minor'] ?? '' };
}

export function parseZfsMounts(mounts: string): Map<string, string> {
  return new Map(
    parseMounts(mounts)
      .filter((mount) => mount.fstype === 'zfs')
      .map((mount) => [mount.target, mount.source]),
  );
}

function parseBytes(value: string): number {
  const bytes = Number(value);

  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error(`zfs: expected a byte count, got ${JSON.stringify(value)}`);
  }

  return bytes;
}

function parseEpochSeconds(value: string): Date | null {
  const seconds = Number(value);

  return Number.isSafeInteger(seconds) && seconds >= 0 ? new Date(seconds * 1000) : null;
}

export function getSnapshotId(name: string): string {
  return name.slice(name.indexOf('@') + 1);
}

export const CHECKPOINT_SNAPSHOT = /@cp-[^@]+$/u;

export function getChildId(name: string, parent: string): string {
  return name.slice(parent.length + 1);
}

export function listChildren(entries: readonly ZfsEntry[], parent: string): ZfsEntry[] {
  return entries.filter(
    (entry) =>
      entry.type === 'filesystem' &&
      entry.name.startsWith(`${parent}/`) &&
      !entry.name.slice(parent.length + 1).includes('/'),
  );
}

export function listCheckpointSnapshots(
  entries: readonly ZfsEntry[],
  checkpointId: string,
): ZfsEntry[] {
  // A restore or a ZFS promote moves a checkpoint's snapshot to another dataset, so it is found by
  // name wherever it is.
  return entries.filter(
    (entry) => entry.type === 'snapshot' && getSnapshotId(entry.name) === checkpointId,
  );
}

export function getCheckpointSnapshot(entries: readonly ZfsEntry[], checkpointId: string): string {
  const snapshots = listCheckpointSnapshots(entries, checkpointId);
  const [snapshot] = snapshots;

  if (snapshots.length !== 1 || snapshot === undefined) {
    throw new Error(
      `zfs: expected one snapshot named ${checkpointId}, found ${String(snapshots.length)}`,
    );
  }

  return snapshot.name;
}
