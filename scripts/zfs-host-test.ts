import { join, resolve } from 'node:path';
import invariant from 'tiny-invariant';
import { match } from 'ts-pattern';
import { pickZfsShard } from '../e2e/lib/suites.ts';
import { ZFS_OWNER_FILE, formatZfsOwnerFile } from '../e2e/lib/zfs-owner.ts';
import type { DevEnv } from './lib/build-dev-layout.ts';
import { DevError } from './lib/dev-error.ts';
import { pickSetting } from './lib/pick-setting.ts';
import { readZfsPoolProperties } from './lib/read-zfs-pool-properties.ts';
import { REPO_ROOT } from './lib/repo-root.ts';
import { toProcessEnv } from './lib/to-process-env.ts';
import { createStopGuard } from './zfs/create-stop-guard.ts';
import type { StopGuard } from './zfs/create-stop-guard.ts';
import { findHostRefusal } from './zfs/find-host-refusal.ts';
import { formatLocalTimestamp } from './zfs/format-local-timestamp.ts';
import { formatZfsTimings } from './zfs/format-zfs-timings.ts';
import { parseZfsOops } from './zfs/parse-zfs-oops.ts';
import { pickCleanupStep } from './zfs/pick-cleanup-step.ts';
import type { CleanupAction, CleanupFacts } from './zfs/pick-cleanup-step.ts';
import { readVdevUse } from './zfs/read-vdev-use.ts';
import { reportZfsError } from './zfs/report-zfs-error.ts';
import type { ZfsHostFacts, ZfsIO } from './zfs/types.ts';
import { wireZfsIO } from './zfs/wire-zfs-io.ts';

const PREFIX = 'zfs-host-test';
const DEV_NAME = 'imp-zfs';
const MOVES_B = `${DEV_NAME}-mv-b`;
const MOVES_NETWORK = `${DEV_NAME}-mv`;
const SUDO_ZPOOL = ['sudo', 'zpool'];

interface RunZfsHostTestOptions {
  readonly env: DevEnv;
  readonly root: string;
  readonly cwd: string;
  readonly io: ZfsIO;
}

// .claude/skills/project-testing/references/zfs-nixos-go-ci.md lists the settings this reads.
export async function runZfsHostTest(options: RunZfsHostTestOptions): Promise<number> {
  try {
    const facts = await readHostFacts(options);

    const refusal = findHostRefusal(facts);

    if (refusal !== null) {
      throw new DevError(refusal);
    }

    invariant(facts.module === 'loaded', 'a host without the zfs module is refused');

    const host = await setUpHost(options, facts);

    return await runOnPool(options, host);
  } catch (error) {
    return reportZfsError(options.io, PREFIX, error);
  }
}

const OWN_PATHS = ['bench.img', 'data', 'data-mv-b'];

async function readHostFacts(options: RunZfsHostTestOptions): Promise<ZfsHostFacts> {
  const io = options.io;

  const versionFile =
    pickSetting(options.env, 'IMP_ZFS_MODULE_VERSION_FILE') ?? '/sys/module/zfs/version';

  const version = io.files.readText(versionFile);

  if (version === null) {
    return { module: 'missing' };
  }

  const pool = `impbench${String(io.pid)}`;

  const listed = await io.shell`sudo zpool list ${pool}`.quiet().nothrow();

  const work = pickSetting(options.env, 'IMP_ZFS_TEST_DIR');

  const existingPaths =
    work === undefined
      ? []
      : OWN_PATHS.map((name) => join(work, name)).filter((path) => io.files.probePath(path));

  const existingContainers: string[] = [];

  for (const name of [DEV_NAME, MOVES_B]) {
    const inspected = await io.shell`docker container inspect ${name}`.quiet().nothrow();

    if (inspected.exitCode === 0) {
      existingContainers.push(name);
    }
  }

  const network = await io.shell`docker network inspect ${MOVES_NETWORK}`.quiet().nothrow();

  return {
    module: 'loaded',
    version,
    pool,
    poolExists: listed.exitCode === 0,
    existingPaths,
    existingContainers,
    existingNetworks: network.exitCode === 0 ? [MOVES_NETWORK] : [],
  };
}

interface Host {
  readonly pool: string;
  readonly work: string;
  readonly img: string;
  readonly env: Record<string, string>;
}

type LoadedHostFacts = Extract<ZfsHostFacts, { module: 'loaded' }>;

async function setUpHost(options: RunZfsHostTestOptions, facts: LoadedHostFacts): Promise<Host> {
  const io = options.io;
  const pool = facts.pool;
  const version = facts.version;

  const work =
    pickSetting(options.env, 'IMP_ZFS_TEST_DIR') ??
    io.files.createTempDirectory('/var/tmp/imp-zfs.');

  io.files.createDirectory(work, { parents: true });

  // Absolute, as zpool status -P prints the vdev.
  const absolute = resolve(work);
  const env = toProcessEnv({ ...options.env, IMP_DEV_NAME: DEV_NAME });

  io.writeStdout(`${PREFIX}: zfs module ${version.replace(/\n+$/u, '')}; results in ${absolute}\n`);

  if ((pickSetting(options.env, 'IMP_ZFS_TEST_UNIT') ?? '1') !== '0') {
    const script = join(options.root, 'scripts', 'test-zfs.sh');
    const path = `PATH=${options.env['PATH'] ?? ''}`;
    const unitDir = `IMP_ZFS_TEST_DIR=${join(absolute, 'unit')}`;

    await io.shell`sudo env ${path} ${unitDir} ${script}`.env(env);

    io.files.removeEmptyDirectory(join(absolute, 'unit'));
  }

  return {
    pool,
    work: absolute,
    img: join(absolute, 'bench.img'),
    env: {
      ...env,
      IMP_DEV_PORT_OFFSET: pickSetting(options.env, 'IMP_DEV_PORT_OFFSET') ?? '300',
      IMP_DEV_DATA: join(absolute, 'data'),
      IMP_STORAGE_BACKEND: 'zfs',
      IMP_ZFS_ROOT: `${pool}/imp`,
      IMP_ZFS_ALLOW_UIOMOVE_BUG: pickSetting(options.env, 'IMP_ZFS_ALLOW_UIOMOVE_BUG') ?? '1',
    },
  };
}

// No flag records the pool: its vdev proves it, since a signal during its create stops the run
// only once the create has finished.
interface Made {
  img: boolean;
  instance: boolean;

  // The local time just before the pool's create, for dmesg --since.
  createdAt: string | null;
}

interface PoolRun {
  readonly options: RunZfsHostTestOptions;
  readonly host: Host;
  readonly guard: StopGuard;
  readonly made: Made;
}

async function runOnPool(options: RunZfsHostTestOptions, host: Host): Promise<number> {
  const run: PoolRun = {
    options,
    host,
    guard: createStopGuard(options.io),
    made: { img: false, instance: false, createdAt: null },
  };

  let status: number;

  try {
    status = await runSuites(run);
  } catch (error) {
    status = run.guard.findStopCode() ?? reportZfsError(options.io, PREFIX, error);
  }

  const cleaned = await removeMade(run, status);

  return run.guard.findStopCode() ?? cleaned;
}

async function runSuites(run: PoolRun): Promise<number> {
  const io = run.options.io;
  const host = run.host;
  const pool = host.pool;
  const zfsRoot = `${pool}/imp`;
  const guard = run.guard;

  // Neither create takes over a path that appeared since the checks.
  io.files.createDirectory(join(host.work, 'data'), { parents: false });
  io.files.createDirectory(join(host.work, 'data-mv-b'), { parents: false });
  io.files.createEmptyFile(host.img);

  run.made.img = true;

  await io.shell`truncate -s ${pickSetting(run.options.env, 'IMP_ZFS_BENCH_GIB') ?? '40'}G ${host.img}`;

  guard.throwIfStopped();

  const properties = readZfsPoolProperties(io.files, run.options.root);

  run.made.createdAt = formatLocalTimestamp(new Date(io.now()));

  await io.shell`sudo zpool create ${properties} ${pool} ${host.img}`;

  guard.throwIfStopped();

  await io.shell`sudo zfs create -o mountpoint=legacy ${zfsRoot}`;

  guard.throwIfStopped();

  // The moves suites' B, on a root dataset of its own (e2e/lib/move-hosts.ts).
  await io.shell`sudo zfs create -o mountpoint=legacy ${zfsRoot}-mv-b`;

  guard.throwIfStopped();

  // What e2e/main.ts proves before it wipes this run's data dirs and datasets to make an instance
  // anew, one owner file for each impd.
  for (const [directory, root] of [
    ['data', zfsRoot],
    ['data-mv-b', `${zfsRoot}-mv-b`],
  ] as const) {
    io.files.writeText(
      join(host.work, directory, ZFS_OWNER_FILE),
      formatZfsOwnerFile({ pool, root, vdev: host.img }),
    );
  }

  run.made.instance = true;

  const status = await runE2E(run);

  await io.shell`docker logs ${DEV_NAME} &> ${join(host.work, 'impd.log')}`.nothrow();

  guard.throwIfStopped();

  await writeReport(run);

  guard.throwIfStopped();

  return status;
}

async function runE2E(run: PoolRun): Promise<number> {
  const io = run.options.io;
  const log = join(run.host.work, 'e2e.log');
  const suites = pickSuites(run.options.env);

  io.files.writeText(log, '');

  const child = io.spawn([join(run.options.root, 'e2e', 'test-e2e.sh'), '--only', suites], {
    cwd: run.options.cwd,
    env: run.host.env,
    output: 'pipe',
  });

  const copies = [child.stdout, child.stderr].map(async (stream) => {
    if (stream === null) {
      return;
    }

    const decoder = new TextDecoder();

    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });

      io.writeStdout(text);
      io.files.appendText(log, text);
    }
  });

  // A stopped run cleans up without waiting for the copies, so a copy that fails then must not end
  // the process as an unhandled rejection.
  const copied = Promise.allSettled(copies);

  const status = await run.guard.runChild(child);

  run.guard.throwIfStopped();

  const results = await copied;

  const failed = results.find((result) => result.status === 'rejected');

  if (failed !== undefined) {
    throw failed.reason;
  }

  return status;
}

// The ZFS lane is every *.zfs.e2e.ts journey, split into IMP_ZFS_SHARD's shard by recorded time.
// IMP_ZFS_E2E_SUITES names VM e2e suites to run on the ZFS backend: alone, it runs only those; beside
// IMP_ZFS_SHARD, it runs them with that share. Neither set runs the whole lane.
function pickSuites(env: DevEnv): string {
  const named = pickSetting(env, 'IMP_ZFS_E2E_SUITES');
  const shard = pickSetting(env, 'IMP_ZFS_SHARD');

  if (shard === undefined) {
    return named ?? pickLaneSuites('1/1');
  }

  return [pickLaneSuites(shard), named ?? ''].filter((suites) => suites !== '').join(',');
}

function pickLaneSuites(shard: string): string {
  const parts = /^(?<index>[1-9]\d*)\/(?<count>[1-9]\d*)$/v.exec(shard)?.groups;
  const index = Number(parts?.['index']);
  const count = Number(parts?.['count']);

  if (parts === undefined || index > count) {
    throw new DevError(`IMP_ZFS_SHARD must be <shard>/<count>, such as 1/2, not ${shard}`);
  }

  return pickZfsShard(index, count).join(',');
}

async function writeReport(run: PoolRun): Promise<void> {
  const io = run.options.io;
  const work = run.host.work;

  const datasets =
    await io.shell`sudo zfs list -r -o name,used,refer,compressratio,recordsize ${run.host.pool}`
      .quiet()
      .nothrow();

  io.writeStderr(datasets.stderr.toString());

  const report =
    formatZfsTimings({
      impdLog: io.files.readText(join(work, 'impd.log')) ?? '',
      e2eLog: io.files.readText(join(work, 'e2e.log')) ?? '',
    }) + datasets.stdout.toString();

  io.writeStdout(`\n${report}`);
  io.files.writeText(join(work, 'summary.txt'), report);
}

async function removeMade(run: PoolRun, status: number): Promise<number> {
  const io = run.options.io;
  const host = run.host;

  if (run.made.instance) {
    await stopInstances(run);
  }

  if (!run.made.img) {
    return status;
  }

  const facts: CleanupFacts = { prefix: PREFIX, pool: host.pool, vdev: host.img, status };

  for (;;) {
    const step = pickCleanupStep(facts);

    if (step.action === 'finish') {
      for (const text of step.stderr) {
        io.writeStderr(text);
      }

      return step.status;
    }

    const seen = await runCleanupStep(run, step.action);

    Object.assign(facts, seen);
  }
}

// The moves suites' B goes first, with its docker proxy and volumes, which a stopped run leaves up
// with B's dataset busy in the pool, then A and the network both were on.
async function stopInstances(run: PoolRun): Promise<void> {
  const io = run.options.io;
  const work = run.host.work;
  const devScript = join(run.options.root, 'scripts', 'dev', 'dev.sh');

  const movesB = await io.shell`docker container inspect ${MOVES_B}`.quiet().nothrow();

  if (movesB.exitCode === 0) {
    await io.shell`docker logs ${MOVES_B} &> ${join(work, 'impd-mv-b.log')}`.nothrow();

    await io.shell`${devScript} down`
      .env({ ...run.host.env, IMP_DEV_NAME: MOVES_B, IMP_DEV_DATA: join(work, 'data-mv-b') })
      .nothrow();
  }

  await io.shell`docker logs ${DEV_NAME} &> ${join(work, 'impd.log')}`.nothrow();
  await io.shell`${devScript} down`.env(run.host.env).nothrow();
  await io.shell`docker network rm ${MOVES_NETWORK}`.quiet().nothrow();
}

function runCleanupStep(run: PoolRun, action: CleanupAction): Promise<Partial<CleanupFacts>> {
  const io = run.options.io;
  const host = run.host;

  return match(action)
    .with('read-own-use', async () => ({
      ownUse: await readVdevUse({
        shell: io.shell,
        zpool: SUDO_ZPOOL,
        vdev: host.img,
        pool: host.pool,
      }),
    }))
    .with('destroy', async () => {
      const destroyed = await io.shell`sudo zpool destroy -f ${host.pool} 2>&1`.quiet().nothrow();

      return { destroyed: { exitCode: destroyed.exitCode, output: destroyed.stdout.toString() } };
    })
    .with('read-oops', async () => ({ oops: await readZfsOops(run) }))
    .with('read-any-use', async () => ({
      anyUse: await readVdevUse({ shell: io.shell, zpool: SUDO_ZPOOL, vdev: host.img, pool: null }),
    }))
    .with('remove', async () => {
      const removed = await io.shell`sudo rm -f ${host.img}`.quiet().nothrow();

      return { removed: { exitCode: removed.exitCode, output: removed.stderr.toString() } };
    })
    .exhaustive();
}

async function readZfsOops(run: PoolRun): Promise<readonly string[]> {
  const createdAt = run.made.createdAt;

  if (createdAt === null) {
    return [];
  }

  const log = await run.options.io.shell`sudo dmesg --since ${createdAt}`.quiet().nothrow();

  return log.exitCode === 0 ? parseZfsOops(log.stdout.toString()) : [];
}

if (import.meta.main) {
  // The tests point IMP_ROOT at a tree of stub scripts in place of the checkout's own.
  const root = pickSetting(process.env, 'IMP_ROOT') ?? REPO_ROOT;

  const exitCode = await runZfsHostTest({
    env: process.env,
    root,
    cwd: process.cwd(),
    io: wireZfsIO(),
  });

  process.exit(exitCode);
}
