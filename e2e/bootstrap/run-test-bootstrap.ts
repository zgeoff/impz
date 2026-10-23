import { join } from 'node:path';
import { $ } from 'bun';
import invariant from 'tiny-invariant';
import { match } from 'ts-pattern';
import { BootstrapTestError } from './bootstrap-test-error';
import { buildBootstrapPlan } from './build-bootstrap-plan';
import { STALE_STUB_IMAGE, STUB_IMAGE, createStubImages } from './create-stub-images';
import { BOOTSTRAP_USAGE, parseBootstrapArgs } from './parse-bootstrap-args';
import type { BootstrapArgs } from './parse-bootstrap-args';
import { removeTestContainer } from './remove-test-container';
import { runDeviceLeg } from './run-device-leg';
import { runDistroLeg } from './run-distro-leg';
import { runZfsLeg } from './run-zfs-leg';
import type { BootstrapIO, BootstrapRun } from './types';

interface RunTestBootstrapOptions {
  readonly argv: readonly string[];
  readonly root: string;
  readonly runID: number;
  readonly io: BootstrapIO;
}

const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const;

type HandledSignal = keyof typeof SIGNAL_EXIT_CODES;

export async function runTestBootstrap(options: RunTestBootstrapOptions): Promise<number> {
  const io = options.io;
  const parsed = parseBootstrapArgs(options.argv);

  if (parsed.kind === 'refused') {
    io.writeStderr(`test-bootstrap: ${parsed.reason}\n`);

    return 2;
  }

  if (parsed.kind === 'help') {
    io.writeStdout(BOOTSTRAP_USAGE);

    return 0;
  }

  const args = parsed.args;

  if (args.zfs && !io.probeReadable('/sys/module/zfs/version')) {
    io.writeStderr('test-bootstrap: --zfs needs the zfs module loaded on this host\n');

    return 2;
  }

  const run = buildRun({ options, args, work: io.createWorkDirectory() });
  const signals: { received: HandledSignal | null } = { received: null };
  const cleanup: { done: Promise<void> | null } = { done: null };

  // A signal and the run's own end can both reach teardown; it runs once.
  const cleanUp = (): Promise<void> => {
    cleanup.done ??= cleanUpRun(run);

    return cleanup.done;
  };

  const stopOnSignal = async (signal: HandledSignal): Promise<void> => {
    if (signals.received !== null) {
      return;
    }

    signals.received = signal;

    await cleanUp();

    io.exit(SIGNAL_EXIT_CODES[signal]);
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    io.onSignal(signal, () => {
      void stopOnSignal(signal);
    });
  }

  let exitCode: number;

  try {
    await runPlan(run);

    exitCode = 0;
  } catch (error) {
    exitCode = reportFailure(io, error);
  } finally {
    await cleanUp();
  }

  return signals.received === null ? exitCode : SIGNAL_EXIT_CODES[signals.received];
}

interface RunParts {
  readonly options: RunTestBootstrapOptions;
  readonly args: BootstrapArgs;
  readonly work: string;
}

function buildRun(parts: RunParts): BootstrapRun {
  const io = parts.options.io;
  const runID = parts.options.runID;
  const image = parts.args.stub ? STUB_IMAGE : parts.args.image;

  invariant(image !== null, 'the arguments give --image or --stub');

  return {
    io,
    root: parts.options.root,
    args: parts.args,
    image,
    work: parts.work,

    // Not a real key: a marker the test looks for in the output.
    fakeKey: `fake-authkey-${String(runID)}-${String(Math.floor(Math.random() * 32_768))}`,
    runID,
    zfsPool: `impt${String(runID)}`,
    state: { container: null },
    log: (line) => {
      io.writeStdout(`test-bootstrap: ${line}`);
    },
  };
}

// A kept container keeps the work directory too, since the container mounts it.
async function cleanUpRun(run: BootstrapRun): Promise<void> {
  const container = run.state.container;

  if (run.args.keep && container !== null) {
    run.io.writeStderr(
      `test-bootstrap: kept ${container}; unmount /var/lib/imp and detach its loop devices before docker rm -f -v\n`,
    );

    return;
  }

  await removeTestContainer(run);

  run.io.removeDirectory(run.work);
}

async function runPlan(run: BootstrapRun): Promise<void> {
  const io = run.io;

  if (run.args.stub) {
    await createStubImages(io);
  }

  io.writeText(join(run.work, 'authkey'), `${run.fakeKey}\n`);
  run.log(`saving ${run.image}`);

  const inspect = await io.shell`docker image inspect ${run.image}`.quiet().nothrow();

  if (inspect.exitCode !== 0) {
    io.writeStderr(inspect.stderr.toString());
    throw new BootstrapTestError(`no local image ${run.image}`);
  }

  await io.shell`docker save -o ${join(run.work, 'image.tar')} ${run.image}`.quiet();

  if (run.args.stub) {
    await io.shell`docker save -o ${join(run.work, 'stale.tar')} ${STALE_STUB_IMAGE}`.quiet();
  }

  for (const leg of buildBootstrapPlan(run.args)) {
    await match(leg)
      .with({ kind: 'distro' }, (distroLeg) => runDistroLeg(run, distroLeg.distro))
      .with({ kind: 'device' }, () => runDeviceLeg(run))
      .with({ kind: 'zfs' }, () => runZfsLeg(run))
      .exhaustive();
  }

  run.log(`passed: ${run.args.distros.join(' ')}`);
}

// A check that fails exits 1; a step that must work and fails exits with its own code, as the bash
// script's set -e did.
function reportFailure(io: BootstrapIO, error: unknown): number {
  if (error instanceof BootstrapTestError) {
    io.writeStderr(`test-bootstrap: FAIL: ${error.message}\n`);

    return 1;
  }

  if (error instanceof $.ShellError) {
    io.writeStderr(error.stderr.toString());

    return error.exitCode;
  }

  throw error;
}
