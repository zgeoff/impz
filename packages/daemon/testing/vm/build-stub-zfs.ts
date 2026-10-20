import type { CommandResult } from '../../src/platform/process/run-command';
import { buildStubZfsStreams } from './build-stub-zfs-streams';

// the `creation` of txg 0: 2026-10-03T00:00:00Z
export const STUB_EPOCH_S = 1_790_985_600;

export interface FakeDataset {
  origin: string | null;
  readonly txg: number;
  readonly properties?: Readonly<Record<string, string>>;
}

export interface FakeSnapshot {
  readonly txg: number;
  deferDestroy: boolean;

  // what a send stream names it by, through renames and across pools
  readonly guid: string;
}

interface FakeZfsOptions {
  readonly root: string;

  // where the root dataset is mounted, as setup-storage.sh mounts it
  readonly rootDir: string;
  readonly userland?: string;
  readonly kernel?: string;
}

export class StubZfsCrashError extends Error {
  override name = 'StubZfsCrashError';
}

// An in-memory ZFS: clones, promote, deferred destroy and legacy mounts, with
// the errors real ZFS gives where impd could trip. It answers impd's argv in
// the real `-H` format and records each command.
export function buildStubZfs(options: FakeZfsOptions) {
  const datasets = new Map<string, FakeDataset>();
  const snapshots = new Map<string, FakeSnapshot>();
  const mounts = new Map<string, string>();
  const readOnlyDirs = new Set<string>();

  const commands: string[] = [];

  const gates: {
    match: (command: string) => boolean;
    opened: Promise<void>;
    reach: () => void;
  }[] = [];

  const failures: ((command: string) => boolean)[] = [];
  const state = { txg: 1, crashAt: null as ((command: string) => boolean) | null, crashed: false };

  datasets.set(options.root, { origin: null, txg: 0 });
  mounts.set(options.rootDir, options.root);

  const findSnapshotsOf = (dataset: string) =>
    [...snapshots.keys()].filter((name) => name.startsWith(`${dataset}@`));

  const findClonesOf = (snapshot: string) =>
    [...datasets.entries()]
      .filter(([, dataset]) => dataset.origin === snapshot)
      .map(([name]) => name);

  const isMounted = (name: string) => [...mounts.values()].includes(name);

  // a marked snapshot goes with its last clone
  const removeUnusedDeferred = (snapshot: string | null) => {
    const found = snapshot === null ? undefined : snapshots.get(snapshot);

    if (snapshot !== null && found?.deferDestroy === true && findClonesOf(snapshot).length === 0) {
      snapshots.delete(snapshot);
    }
  };

  const updateSnapshotName = (from: string, to: string) => {
    const snapshot = snapshots.get(from);

    if (snapshot !== undefined) {
      snapshots.delete(from);
      snapshots.set(to, snapshot);
    }

    for (const dataset of datasets.values()) {
      if (dataset.origin === from) {
        dataset.origin = to;
      }
    }
  };

  const createDataset = (name: string): CommandResult => {
    if (datasets.has(name)) {
      return buildFailure(`cannot create '${name}': dataset already exists`);
    }

    if (!datasets.has(getParent(name))) {
      return buildFailure(`cannot create '${name}': parent does not exist`);
    }

    datasets.set(name, { origin: null, txg: state.txg++ });

    return buildSuccess();
  };

  const createSnapshot = (name: string): CommandResult => {
    const [dataset = ''] = name.split('@');

    if (!datasets.has(dataset)) {
      return buildFailure(`cannot open '${dataset}': dataset does not exist`);
    }

    if (snapshots.has(name)) {
      return buildFailure(`cannot create snapshot '${name}': dataset already exists`);
    }

    snapshots.set(name, { txg: state.txg++, deferDestroy: false, guid: Bun.randomUUIDv7() });

    return buildSuccess();
  };

  const createClone = (
    origin: string,
    target: string,
    properties: Readonly<Record<string, string>>,
  ): CommandResult => {
    if (!snapshots.has(origin)) {
      return buildFailure(`cannot open '${origin}': dataset does not exist`);
    }

    if (datasets.has(target)) {
      return buildFailure(`cannot create '${target}': dataset already exists`);
    }

    if (!datasets.has(getParent(target))) {
      return buildFailure(`cannot create '${target}': parent does not exist`);
    }

    datasets.set(target, { origin, txg: state.txg++, properties });

    return buildSuccess();
  };

  const updateDatasetName = (from: string, to: string): CommandResult => {
    const dataset = datasets.get(from);

    if (dataset === undefined) {
      return buildFailure(`cannot open '${from}': dataset does not exist`);
    }

    if (datasets.has(to) || !datasets.has(getParent(to))) {
      return buildFailure(
        `cannot rename to '${to}': dataset already exists or parent does not exist`,
      );
    }

    if ([...datasets.keys()].some((name) => name.startsWith(`${from}/`))) {
      return buildFailure(`fake zfs: impd never renames a dataset with children (${from})`);
    }

    if (isMounted(from)) {
      return buildFailure(`fake zfs: impd unmounts before a rename (${from})`);
    }

    datasets.delete(from);
    datasets.set(to, dataset);

    for (const name of findSnapshotsOf(from)) {
      updateSnapshotName(name, `${to}${name.slice(from.length)}`);
    }

    return buildSuccess();
  };

  // the clone takes over its origin snapshot and every older one; the old
  // parent becomes a clone of the origin
  const runPromote = (name: string): CommandResult => {
    const promoted = datasets.get(name);

    if (promoted?.origin === undefined || promoted.origin === null) {
      return buildFailure(`cannot promote '${name}': not a cloned filesystem`);
    }

    const origin = promoted.origin;
    const [parentName = ''] = origin.split('@');
    const parent = datasets.get(parentName);
    const originTxg = snapshots.get(origin)?.txg ?? 0;

    if (parent === undefined) {
      return buildFailure(`fake zfs: the parent of ${origin} is gone`);
    }

    const moving = findSnapshotsOf(parentName).filter(
      (snapshotName) => (snapshots.get(snapshotName)?.txg ?? 0) <= originTxg,
    );

    for (const snapshotName of moving) {
      if (snapshots.has(`${name}${snapshotName.slice(parentName.length)}`)) {
        return buildFailure(`cannot promote '${name}': snapshot name conflict`);
      }
    }

    promoted.origin = parent.origin;

    for (const snapshotName of moving) {
      updateSnapshotName(snapshotName, `${name}${snapshotName.slice(parentName.length)}`);
    }

    parent.origin = `${name}${origin.slice(parentName.length)}`;

    return buildSuccess();
  };

  const runDestroy = (name: string, deferred: boolean): CommandResult => {
    if (name.includes('@')) {
      if (!snapshots.has(name)) {
        return buildFailure(`could not find any snapshots to destroy; check snapshot names.`);
      }

      if (findClonesOf(name).length > 0) {
        if (!deferred) {
          return buildFailure(`cannot destroy '${name}': snapshot has dependent clones`);
        }

        const found = snapshots.get(name);

        if (found !== undefined) {
          found.deferDestroy = true;
        }

        return buildSuccess();
      }

      snapshots.delete(name);

      return buildSuccess();
    }

    const dataset = datasets.get(name);

    if (dataset === undefined) {
      return buildFailure(`cannot open '${name}': dataset does not exist`);
    }

    if (
      findSnapshotsOf(name).length > 0 ||
      [...datasets.keys()].some((other) => other.startsWith(`${name}/`))
    ) {
      return buildFailure(`cannot destroy '${name}': filesystem has children`);
    }

    if (isMounted(name)) {
      return buildFailure(`cannot destroy '${name}': dataset is busy`);
    }

    datasets.delete(name);

    removeUnusedDeferred(dataset.origin);

    return buildSuccess();
  };

  // zfs destroy -R: the dataset, its children and their snapshots, and every
  // clone of those snapshots wherever it is; a mounted one stops it
  const runDestroyAll = (root: string): CommandResult => {
    if (!datasets.has(root)) {
      return buildFailure(`cannot open '${root}': dataset does not exist`);
    }

    const doomed = new Set<string>();

    const pending = [root];

    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      doomed.add(next);

      pending.push(
        ...[...datasets.keys()].filter((name) => name.startsWith(`${next}/`)),
        ...findSnapshotsOf(next).flatMap((snapshot) => findClonesOf(snapshot)),
      );
    }

    const busy = [...doomed].find((name) => isMounted(name));

    if (busy !== undefined) {
      return buildFailure(`cannot destroy '${busy}': dataset is busy`);
    }

    for (const name of doomed) {
      for (const snapshot of findSnapshotsOf(name)) {
        snapshots.delete(snapshot);
      }

      datasets.delete(name);
    }

    return buildSuccess();
  };

  const listTree = (root: string): CommandResult => {
    if (!datasets.has(root)) {
      return buildFailure(`cannot open '${root}': dataset does not exist`);
    }

    const isInTree = (name: string) => name === root || name.startsWith(`${root}/`);

    const rows = [
      ...[...datasets.entries()]
        .filter(([name]) => isInTree(name))
        .map(([name, dataset]) => ({
          txg: dataset.txg,
          line: `${name}\tfilesystem\t${dataset.origin ?? '-'}\t-`,
        })),
      ...[...snapshots.entries()]
        .filter(([name]) => isInTree(name.split('@')[0] ?? ''))
        .map(([name, found]) => ({
          txg: found.txg,
          line: `${name}\tsnapshot\t-\t${found.deferDestroy ? 'on' : 'off'}`,
        })),
    ].toSorted((left, right) => left.txg - right.txg);

    return buildSuccess(rows.map((row) => `${row.line}\n`).join(''));
  };

  // every dataset holds 1 MiB of its own and refers to 3; a snapshot holds 64
  // KiB. Each was created an hour after STUB_EPOCH_S per txg.
  const listSpace = (root: string): CommandResult => {
    const isInTree = (name: string) => name === root || name.startsWith(`${root}/`);
    const readCreation = (txg: number) => String(STUB_EPOCH_S + txg * 3600);

    const rows = [
      ...[...datasets.entries()]
        .filter(([name]) => isInTree(name))
        .map(
          ([name, dataset]) =>
            `${name}\t1048576\t3145728\t1048576\t${readCreation(dataset.txg)}\t-`,
        ),
      ...[...snapshots.entries()]
        .filter(([name]) => isInTree(name.split('@')[0] ?? ''))
        .map(([name, snapshot]) => {
          const clones = findClonesOf(name);

          return `${name}\t65536\t1048576\t-\t${readCreation(snapshot.txg)}\t${clones.length === 0 ? '-' : clones.join(',')}`;
        }),
    ];

    return buildSuccess(rows.map((row) => `${row}\n`).join(''));
  };

  const handleCommand = (argv: readonly string[]): CommandResult => {
    const [tool = '', verb = '', ...rest] = argv;
    const last = argv.at(-1) ?? '';

    // mount -t zfs [-o ro] <name> <dir>; like a real legacy mount, the
    // readonly property does not make it read-only
    if (tool === 'mount') {
      const name = argv.at(-2) ?? '';
      const directory = last;

      if (!datasets.has(name)) {
        return buildFailure(`mount: ${directory}: ${name} does not exist`);
      }

      if (mounts.has(directory)) {
        return buildFailure(`mount: ${directory}: already mounted`);
      }

      mounts.set(directory, name);

      if (rest.includes('ro')) {
        readOnlyDirs.add(directory);
      }

      return buildSuccess();
    }

    // umount -R <dir>: the dir and every mount beneath it, deepest first; as
    // util-linux, the dir itself must be a mount
    if (tool === 'umount' && verb === '-R') {
      if (!mounts.has(last)) {
        return buildFailure(`umount: ${last}: not mounted.`);
      }

      const under = [...mounts.keys()]
        .filter((directory) => directory === last || directory.startsWith(`${last}/`))
        .toSorted((left, right) => right.length - left.length);

      for (const directory of under) {
        mounts.delete(directory);
        readOnlyDirs.delete(directory);
      }

      return buildSuccess();
    }

    if (tool === 'umount') {
      readOnlyDirs.delete(verb);

      if (!mounts.delete(verb)) {
        return buildFailure(`umount: ${verb}: not mounted.`);
      }

      return buildSuccess();
    }

    if (verb === 'version') {
      return buildSuccess(
        `zfs-${options.userland ?? '2.4.4'}\nzfs-kmod-${options.kernel ?? '2.4.4'}\n`,
      );
    }

    if (verb === 'list' && argv.includes('name,used,referenced,usedbydataset,creation,clones')) {
      return listSpace(last);
    }

    if (verb === 'list' && argv.includes('used,available')) {
      return buildSuccess('1073741824\t9663676416\n');
    }

    if (verb === 'list') {
      return listTree(last);
    }

    if (verb === 'get') {
      return snapshots.has(last)
        ? buildSuccess('65536\n')
        : buildFailure(`cannot open '${last}': dataset does not exist`);
    }

    if (verb === 'create') {
      return createDataset(last);
    }

    if (verb === 'snapshot') {
      return createSnapshot(last);
    }

    // zfs clone [-o key=value]… <snapshot> <target>
    if (verb === 'clone') {
      const properties: Record<string, string> = {};

      for (const [index, arg] of rest.entries()) {
        const [key = '', value = ''] = arg.split('=');

        if (rest[index - 1] === '-o') {
          properties[key] = value;
        }
      }

      return createClone(argv.at(-2) ?? '', last, properties);
    }

    if (verb === 'rename') {
      return updateDatasetName(rest[0] ?? '', last);
    }

    if (verb === 'promote') {
      return runPromote(last);
    }

    if (verb === 'destroy' && rest[0] === '-R') {
      return runDestroyAll(last);
    }

    if (verb === 'destroy' && rest[0] === '-r') {
      for (const snapshot of findSnapshotsOf(last).toReversed()) {
        const result = runDestroy(snapshot, false);

        if (result.exitCode !== 0) {
          return result;
        }
      }

      return runDestroy(last, false);
    }

    if (verb === 'destroy') {
      return runDestroy(last, rest[0] === '-d');
    }

    // zfs send -nP [-i <base>] <snapshot>: every stream is 1 MiB
    if (verb === 'send') {
      return snapshots.has(last)
        ? buildSuccess(`full\t${last}\t1048576\nsize\t1048576\n`)
        : buildFailure(`cannot open '${last}': dataset does not exist`);
    }

    return buildFailure(`fake zfs: unknown command ${argv.join(' ')}`);
  };

  const streams = buildStubZfsStreams({ datasets, snapshots, state, commands, findSnapshotsOf });

  return {
    commands,
    streams,

    run: async (argv: readonly string[]): Promise<CommandResult> => {
      const command = argv.join(' ');

      if (state.crashed || state.crashAt?.(command) === true) {
        state.crashed = true;
        throw new StubZfsCrashError(`crashed before ${command}`);
      }

      for (const gate of gates.filter((candidate) => candidate.match(command))) {
        gate.reach();

        await gate.opened;
      }

      const failure = failures.findIndex((match) => match(command));

      if (failure !== -1) {
        failures.splice(failure, 1);

        return buildFailure(`fake zfs: ${command} failed`);
      }

      commands.push(command);

      return handleCommand(argv);
    },

    // matching commands wait until release runs; reached resolves once the
    // first one waits
    blockBefore: (match: (command: string) => boolean) => {
      const gate = Promise.withResolvers<void>();
      const reached = Promise.withResolvers<void>();

      gates.push({ match, opened: gate.promise, reach: reached.resolve });

      return {
        reached: reached.promise,
        release: () => {
          gate.resolve();
        },
      };
    },

    // the next matching command exits 1 and changes nothing
    failOnce: (match: (command: string) => boolean) => {
      failures.push(match);
    },

    readMounts: () =>
      [...mounts.entries()]
        .map(
          ([directory, name]) =>
            `${name} ${directory.replaceAll(' ', String.raw`\040`)} zfs ${readOnlyDirs.has(directory) ? 'ro' : 'rw'},noatime,xattr,noacl 0 0\n`,
        )
        .join(''),

    // every later command fails, as if impd died just before the matching one
    crashBefore: (match: (command: string) => boolean) => {
      state.crashAt = match;
    },

    // a new impd on the same pool; mounts made in the container survive only
    // a restart of impd, so `dropMounts` models a container restart
    restart: (dropMounts = false) => {
      state.crashAt = null;
      state.crashed = false;

      if (dropMounts) {
        for (const directory of mounts.keys()) {
          if (directory !== options.rootDir) {
            mounts.delete(directory);
          }
        }
      }
    },

    listDatasets: () => [...datasets.keys()].toSorted(),
    listSnapshots: () => [...snapshots.keys()].toSorted(),
    readOrigin: (name: string) => datasets.get(name)?.origin ?? null,
    readTxg: (name: string) => (datasets.get(name) ?? snapshots.get(name))?.txg ?? 0,

    // the `creation` the space rows give `name`: an hour after STUB_EPOCH_S per txg
    readCreatedAt: (name: string) =>
      new Date(
        (STUB_EPOCH_S + ((datasets.get(name) ?? snapshots.get(name))?.txg ?? 0) * 3600) * 1000,
      ),
    readProperty: (name: string, key: string) => datasets.get(name)?.properties?.[key] ?? null,
    isDeferred: (name: string) => snapshots.get(name)?.deferDestroy ?? false,
    readMountedAt: (directory: string) => mounts.get(directory) ?? null,
    isReadOnlyAt: (directory: string) => readOnlyDirs.has(directory),
  };
}

function buildFailure(message: string): CommandResult {
  return { exitCode: 1, stdout: '', stderr: message };
}

function getParent(name: string): string {
  return name.slice(0, name.lastIndexOf('/'));
}

function buildSuccess(stdout = ''): CommandResult {
  return { exitCode: 0, stdout, stderr: '' };
}

export type StubZfs = ReturnType<typeof buildStubZfs>;
