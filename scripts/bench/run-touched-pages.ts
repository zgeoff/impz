import { ORPCError } from '@impz/client';
import type { ImpClient } from '@impz/client';
import { parseHugetlbMib } from '@impz/e2e-harness/huge-page-host';
import type { CommandResult } from '@impz/e2e-harness/instance';
import { waitFor } from '@impz/e2e-harness/wait-for';
import type { DevLock } from '../lib/create-dev-lock.ts';
import { ChangedPagesReportSchema } from './changed-pages-report-schema';

interface TouchedPagesClient {
  readonly system: Pick<ImpClient['system'], 'info'>;
  readonly imps: Pick<ImpClient['imps'], 'get' | 'create' | 'destroy'>;
}

export interface TouchedPagesDeps {
  readonly lockDev: () => DevLock;
  readonly client: TouchedPagesClient;
  readonly runImpz: (args: readonly string[]) => Promise<CommandResult>;
  readonly runInContainer: (argv: readonly string[]) => Promise<CommandResult>;
  readonly now: () => number;
  readonly sleep: (durationMs: number) => Promise<void>;
  readonly onStderr: (text: string) => void;
}

export interface TouchedPagesOptions {
  readonly memory: string;
  readonly memoryMib: number;
  readonly writeMib: number;
}

export interface TouchedPages {
  readonly memory: string;
  readonly writeMib: number;
  readonly coldSleep: { readonly touchedMib: number; readonly memFileMib: number };
  readonly wokenSleep: {
    readonly touchedMib: number;
    readonly changedMib: number;
    readonly changedHugeMib: number;
    readonly memFileMib: number;
  };
}

const NAME = 'touched-pages';

// The dev instance's lock keeps other bench runs off it, and the run refuses
// an imp of its name that it found, so a record a failed create left under
// that name is this run's to remove.
export async function runTouchedPages(
  deps: TouchedPagesDeps,
  options: Readonly<TouchedPagesOptions>,
): Promise<TouchedPages> {
  const lock = deps.lockDev();

  try {
    await waitForReady(deps, "impd's default image", () => requireDefaultImage(deps));

    const found = await deps.client.imps.get({ name: NAME }).then(
      () => true,
      (error: unknown) => {
        if (isRPCCode(error, 'NOT_FOUND')) {
          return false;
        }

        throw error;
      },
    );

    if (found) {
      throw new Error(`measure-touched-pages: ${NAME} already exists, so this run leaves it`);
    }

    const createFailure = await deps.client.imps
      .create({ name: NAME, memoryMib: options.memoryMib })
      .then(
        () => null,
        (error: unknown) => error,
      );

    if (isRPCCode(createFailure, 'CONFLICT')) {
      throw new Error(
        `measure-touched-pages: ${NAME} appeared during the run, so this run leaves it`,
      );
    }

    let measured: TouchedPages;
    let isClean = false;

    try {
      if (createFailure !== null) {
        throw new Error(`measure-touched-pages: the create of ${NAME} failed`, {
          cause: createFailure,
        });
      }

      measured = await measureTouchedPages(deps, options);
    } finally {
      isClean = await removeLeftovers(deps);
    }

    if (!isClean) {
      throw new Error(
        'measure-touched-pages: the cleanup failed, so the dev instance keeps a leftover',
      );
    }

    return measured;
  } finally {
    releaseLock(deps, lock);
  }
}

const READY_TIMEOUT_MS = 300_000;
const POLL_MS = 1000;

async function waitForReady(
  deps: TouchedPagesDeps,
  what: string,
  attempt: () => Promise<void>,
): Promise<void> {
  await waitFor(`measure-touched-pages: ${what}`, attempt, {
    intervalMs: POLL_MS,
    timeoutMs: READY_TIMEOUT_MS,
    now: deps.now,
    wait: deps.sleep,
  });
}

async function requireDefaultImage(deps: TouchedPagesDeps): Promise<void> {
  const info = await deps.client.system.info();

  if ((info.defaults?.image ?? null) === null) {
    throw new Error('impd has no default image yet');
  }
}

function isRPCCode(error: unknown, code: string): boolean {
  return error instanceof ORPCError && error.code === code;
}

const BASE_COPY = '/var/lib/imp/touched-pages-base';

async function measureTouchedPages(
  deps: TouchedPagesDeps,
  options: Readonly<TouchedPagesOptions>,
): Promise<TouchedPages> {
  await waitForReady(deps, `${NAME} to run a command`, async () => {
    await runImpzChecked(deps, ['exec', NAME, '--', 'true']);
  });

  const imp = await deps.client.imps.get({ name: NAME });

  const directory = `/var/lib/imp/imps/${imp.id}`;
  const memFile = `${directory}/snapshot/mem`;

  // a cold boot sleeps as a diff over an empty file
  await runImpzChecked(deps, [
    'exec',
    NAME,
    '--',
    'sh',
    '-c',
    `dd if=/dev/urandom of=/dev/shm/written bs=1M count=${String(options.writeMib)}`,
  ]);

  const coldTouchedMib = await readHugetlbMib(deps, directory);

  await runImpzChecked(deps, ['sleep', NAME]);

  const coldFileMib = await readAllocatedMib(deps, memFile);

  // every page the woken guest reads back faults in from the handler, so the
  // diff takes it though no byte of it changed
  await runImpzChecked(deps, ['wake', NAME]);

  await runImpzChecked(deps, [
    'exec',
    NAME,
    '--',
    'sh',
    '-c',
    'sha256sum /dev/shm/written && sleep 5',
  ]);

  const wokenTouchedMib = await readHugetlbMib(deps, directory);
  const handlerPid = await readContainer(deps, ['cat', `${directory}/run/uffd.pid`]);

  await readContainer(deps, ['cp', '--sparse=always', `/proc/${handlerPid}/fd/3`, BASE_COPY]);
  await runImpzChecked(deps, ['sleep', NAME]);

  const wokenFileMib = await readAllocatedMib(deps, memFile);

  const counted = await readContainer(deps, [
    'bun',
    '/src/scripts/bench/count-changed-pages.ts',
    BASE_COPY,
    memFile,
  ]);

  const changed = ChangedPagesReportSchema.parse(JSON.parse(counted));

  return {
    memory: options.memory,
    writeMib: options.writeMib,
    coldSleep: { touchedMib: coldTouchedMib, memFileMib: coldFileMib },
    wokenSleep: {
      touchedMib: wokenTouchedMib,
      changedMib: changed.changedMib,
      changedHugeMib: changed.changedHugeMib,
      memFileMib: wokenFileMib,
    },
  };
}

async function runImpzChecked(deps: TouchedPagesDeps, args: readonly string[]): Promise<string> {
  const ran = await deps.runImpz(args);

  return requireSuccess(ran, `impz ${args.join(' ')}`);
}

function requireSuccess(ran: Readonly<CommandResult>, what: string): string {
  if (ran.exitCode !== 0) {
    throw new Error(`measure-touched-pages: ${what} exited ${String(ran.exitCode)}: ${ran.stderr}`);
  }

  return ran.stdout;
}

async function readHugetlbMib(deps: TouchedPagesDeps, directory: string): Promise<number> {
  const pid = await readContainer(deps, ['cat', `${directory}/run/pid`]);
  const status = await readContainer(deps, ['cat', `/proc/${pid}/status`]);

  return parseHugetlbMib(status);
}

async function readContainer(deps: TouchedPagesDeps, argv: readonly string[]): Promise<string> {
  const ran = await deps.runInContainer(argv);

  return requireSuccess(ran, argv.join(' ')).trim();
}

async function readAllocatedMib(deps: TouchedPagesDeps, path: string): Promise<number> {
  const shown = await readContainer(deps, ['stat', '-c', '%b', path]);

  const blocks = Number(shown);

  if (!Number.isInteger(blocks)) {
    throw new TypeError(`measure-touched-pages: stat gave no block count for ${path}`);
  }

  return Math.round((blocks * 512) / 1_048_576);
}

// A remove of an imp that the failed create never recorded finds nothing,
// which leaves nothing behind. Neither step throws, so both run and an
// earlier failure stays the run's error.
async function removeLeftovers(deps: TouchedPagesDeps): Promise<boolean> {
  const copyFailure = await deps.runInContainer(['rm', '-f', BASE_COPY]).then(
    (removed) => (removed.exitCode === 0 ? null : removed.stderr),
    (error: unknown) => formatReason(error),
  );

  const impFailure = await deps.client.imps.destroy({ name: NAME }).then(
    () => null,
    (error: unknown) => (isRPCCode(error, 'NOT_FOUND') ? null : formatReason(error)),
  );

  if (copyFailure !== null) {
    deps.onStderr(`measure-touched-pages: could not remove ${BASE_COPY}: ${copyFailure}`);
  }

  if (impFailure !== null) {
    deps.onStderr(`measure-touched-pages: could not remove ${NAME}: ${impFailure}`);
  }

  return copyFailure === null && impFailure === null;
}

function formatReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// a lock left behind refuses the next run with its path, so a failed release
// is reported and never replaces the run's own error
function releaseLock(deps: TouchedPagesDeps, lock: DevLock): void {
  try {
    lock.release();
  } catch (error) {
    deps.onStderr(`measure-touched-pages: could not release the dev lock: ${formatReason(error)}`);
  }
}
