import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { match } from 'ts-pattern';
import type { DevEnv } from './lib/build-dev-layout.ts';
import { DevError } from './lib/dev-error.ts';
import { pickSetting } from './lib/pick-setting.ts';
import { readZfsPoolProperties } from './lib/read-zfs-pool-properties.ts';
import { REPO_ROOT } from './lib/repo-root.ts';
import { createStopGuard } from './zfs/create-stop-guard.ts';
import type { StopGuard } from './zfs/create-stop-guard.ts';
import { readVdevUse } from './zfs/read-vdev-use.ts';
import { reportZfsError } from './zfs/report-zfs-error.ts';
import type { ZfsIO } from './zfs/types.ts';
import { wireZfsIO } from './zfs/wire-zfs-io.ts';

const PREFIX = 'test-zfs';

interface RunTestZfsOptions {
  readonly env: DevEnv;
  readonly root: string;
  readonly io: ZfsIO;
}

// .claude/skills/project-testing/references/zfs-nixos-go-ci.md lists the settings this reads.
export async function runTestZfs(options: RunTestZfsOptions): Promise<number> {
  try {
    const host = await checkHost(options);

    return await runOnPool(options, host);
  } catch (error) {
    return reportZfsError(options.io, PREFIX, error);
  }
}

interface Host {
  readonly pool: string;
  readonly gib: string;
  readonly work: string | undefined;
}

// A generated name is not ownership, so a name that is in use is still refused.
async function checkHost(options: RunTestZfsOptions): Promise<Host> {
  const io = options.io;
  const env = options.env;
  const versionFile = pickSetting(env, 'IMP_ZFS_MODULE_VERSION_FILE') ?? '/sys/module/zfs/version';

  const uid = await io.shell`id -u`.quiet().nothrow();

  if (uid.stdout.toString().trim() !== '0') {
    const script = join(options.root, 'scripts', 'test-zfs.sh');

    throw new DevError(`run as root: sudo env "PATH=$PATH" ${script}`);
  }

  const version = io.files.readText(versionFile);

  if (version === null) {
    throw new DevError('the zfs kernel module is not loaded (modprobe zfs)');
  }

  if (io.findBinary('zpool') === null) {
    throw new DevError('zpool is missing; install zfsutils-linux');
  }

  const pool = `imptest${String(io.pid)}`;
  const work = pickSetting(env, 'IMP_ZFS_TEST_DIR');

  const listed = await io.shell`zpool list ${pool}`.quiet().nothrow();

  if (listed.exitCode === 0) {
    throw new DevError(`a pool named ${pool} already exists; refusing to touch it`);
  }

  for (const name of ['pool.img', 'mnt']) {
    if (work !== undefined && io.files.probePath(join(work, name))) {
      throw new DevError(`${join(work, name)} already exists; refusing to touch it`);
    }
  }

  const userland = await io.shell`zfs version`.quiet().nothrow();

  const userlandVersion = userland.stdout.toString().split('\n')[0] ?? '';

  io.writeStdout(
    `${PREFIX}: zfs ${version.replace(/\n+$/u, '')} (module), ${userlandVersion} (userland)\n`,
  );

  return { pool, gib: pickSetting(env, 'IMP_ZFS_TEST_GIB') ?? '4', work };
}

// No flag records the pool: its vdev proves it, since a signal during its create stops the run
// only once the create has finished.
interface Made {
  work: boolean;
  mnt: boolean;
  img: boolean;
}

interface PoolRun {
  readonly options: RunTestZfsOptions;
  readonly host: Host;
  readonly guard: StopGuard;
  readonly made: Made;
  readonly work: string;
  readonly mnt: string;
  readonly img: string;
}

async function runOnPool(options: RunTestZfsOptions, host: Host): Promise<number> {
  const files = options.io.files;
  const made: Made = { work: false, mnt: false, img: false };
  let work = host.work;

  if (work === undefined) {
    work = files.createTempDirectory(join(tmpdir(), 'imp-test-zfs.'));
    made.work = true;
  } else if (!files.probeDirectory(work)) {
    files.createDirectory(work, { parents: true });

    made.work = true;
  }

  // Absolute, as zpool status -P prints the vdev.
  work = resolve(work);

  const run: PoolRun = {
    options,
    host,
    guard: createStopGuard(options.io),
    made,
    work,
    mnt: join(work, 'mnt'),
    img: join(work, 'pool.img'),
  };

  let status: number;

  try {
    status = await runTests(run);
  } catch (error) {
    status = run.guard.findStopCode() ?? reportZfsError(options.io, PREFIX, error);
  }

  return removeMade(run, status);
}

async function runTests(run: PoolRun): Promise<number> {
  const io = run.options.io;
  const pool = run.host.pool;
  const guard = run.guard;

  // Neither create takes over a path that appeared since the checks.
  io.files.createDirectory(run.mnt, { parents: false });

  run.made.mnt = true;

  io.files.createEmptyFile(run.img);

  run.made.img = true;

  await io.shell`truncate -s ${run.host.gib}G ${run.img}`;

  guard.throwIfStopped();

  const properties = readZfsPoolProperties(io.files, run.options.root);

  await io.shell`zpool create ${properties} ${pool} ${run.img}`;

  guard.throwIfStopped();

  await io.shell`zfs create -o mountpoint=legacy ${pool}/imp`;

  guard.throwIfStopped();

  await io.shell`mount -t zfs ${pool}/imp ${run.mnt}`;

  guard.throwIfStopped();

  const child = io.spawn(['bun', 'test', 'packages/daemon/src/vm/storage/zfs'], {
    cwd: run.options.root,
    env: { ...run.options.env, IMP_TEST_ZFS_ROOT: `${pool}/imp`, IMP_TEST_ZFS_DIR: run.mnt },
    output: 'inherit',
  });

  const exitCode = await guard.runChild(child);

  guard.throwIfStopped();

  return exitCode;
}

// The tests mount datasets under the mount point, and a test that fails can leave them. A pool
// that will not go keeps its file, so it can still be imported and destroyed by hand.
async function removeMade(run: PoolRun, status: number): Promise<number> {
  const io = run.options.io;
  const pool = run.host.pool;
  const failed = status === 0 ? 1 : status;

  if (run.made.mnt) {
    await io.shell`umount -R ${run.mnt}`.quiet().nothrow();
  }

  if (run.made.img) {
    const ownUse = await readVdevUse({ shell: io.shell, zpool: ['zpool'], vdev: run.img, pool });

    if (ownUse === 'used') {
      const destroyed = await io.shell`zpool destroy -f ${pool}`.nothrow();

      if (destroyed.exitCode !== 0) {
        io.writeStderr(`${PREFIX}: could not destroy ${pool}; its file stays at ${run.img}\n`);

        return failed;
      }
    }

    // Never the file of a pool that is still there, or may be.
    const anyUse = await readVdevUse({
      shell: io.shell,
      zpool: ['zpool'],
      vdev: run.img,
      pool: null,
    });

    const kept = match(anyUse)
      .with('unused', () => null)
      .with('used', () => `a pool still uses ${run.img}; it stays`)
      .with('unknown', () => `zpool cannot say which pools use ${run.img}; it stays`)
      .exhaustive();

    if (kept !== null) {
      io.writeStderr(`${PREFIX}: ${kept}\n`);

      return failed;
    }

    io.files.removeFile(run.img);
  }

  if (run.made.mnt) {
    io.files.removeEmptyDirectory(run.mnt);
  }

  if (run.made.work) {
    io.files.removeEmptyDirectory(run.work);
  }

  return status;
}

if (import.meta.main) {
  const exitCode = await runTestZfs({ env: process.env, root: REPO_ROOT, io: wireZfsIO() });

  process.exit(exitCode);
}
