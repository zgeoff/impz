import { ImpSchema, SystemInfoSchema } from '@impz/api';
import { parseHugetlbMib } from '@impz/e2e-harness/huge-page-host';
import * as z from 'zod';
import type { DevLock } from '../lib/create-dev-lock.ts';
import { parseJSONOrNull } from '../lib/parse-json-or-null.ts';
import type { CommandRun } from './run-bench-arm';

export interface TouchedPagesDeps {
  readonly lockDev: () => DevLock;
  readonly runImpz: (args: readonly string[]) => Promise<CommandRun>;
  readonly runInContainer: (argv: readonly string[]) => Promise<CommandRun>;
  readonly now: () => number;
  readonly wait: (durationMs: number) => Promise<void>;
  readonly onStderr: (text: string) => void;
}

export interface TouchedPagesOptions {
  readonly memory: string;
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
    await waitUntil(deps, 'impd never added its default image', () => probeDefaultImage(deps));

    const found = await deps.runImpz(['info', NAME, '--json']);

    if (found.exitCode === 0 || !/\bNOT_FOUND:/u.test(found.stderr)) {
      throw new Error(
        `measure-touched-pages: ${NAME} already exists or could not be looked up, so this run leaves it: ${found.stderr}`,
      );
    }

    const created = await deps.runImpz(['new', NAME, '--memory', options.memory]);

    if (created.exitCode !== 0 && /\bCONFLICT:/u.test(created.stderr)) {
      throw new Error(
        `measure-touched-pages: ${NAME} appeared during the run, so this run leaves it`,
      );
    }

    try {
      requireSuccess(created, `impz new ${NAME}`);

      return await measureTouchedPages(deps, options);
    } finally {
      await removeLeftovers(deps);
    }
  } finally {
    lock.release();
  }
}

const READY_TIMEOUT_MS = 300_000;
const POLL_MS = 1000;

async function waitUntil(
  deps: TouchedPagesDeps,
  failure: string,
  isDone: () => Promise<boolean>,
): Promise<void> {
  const deadline = deps.now() + READY_TIMEOUT_MS;

  for (;;) {
    const done = await isDone();

    if (done) {
      return;
    }

    if (deps.now() >= deadline) {
      throw new Error(`measure-touched-pages: ${failure}`);
    }

    await deps.wait(POLL_MS);
  }
}

const InfoSchema = SystemInfoSchema.pick({ defaults: true });

async function probeDefaultImage(deps: TouchedPagesDeps): Promise<boolean> {
  const shown = await deps.runImpz(['info', '--json']);

  if (shown.exitCode !== 0) {
    return false;
  }

  const info = InfoSchema.safeParse(parseJSONOrNull(shown.stdout));

  return info.success && (info.data.defaults?.image ?? null) !== null;
}

function requireSuccess(ran: Readonly<CommandRun>, what: string): string {
  if (ran.exitCode !== 0) {
    throw new Error(`measure-touched-pages: ${what} exited ${String(ran.exitCode)}: ${ran.stderr}`);
  }

  return ran.stdout;
}

const BASE_COPY = '/var/lib/imp/touched-pages-base';
const ImpIDSchema = ImpSchema.pick({ id: true });
const ChangedSchema = z.object({ changedMib: z.number(), changedHugeMib: z.number() });

async function measureTouchedPages(
  deps: TouchedPagesDeps,
  options: Readonly<TouchedPagesOptions>,
): Promise<TouchedPages> {
  await waitUntil(deps, `${NAME} never ran a command`, async () => {
    const ran = await deps.runImpz(['exec', NAME, '--', 'true']);

    return ran.exitCode === 0;
  });

  const shown = await runImpzChecked(deps, ['info', NAME, '--json']);

  const directory = `/var/lib/imp/imps/${ImpIDSchema.parse(JSON.parse(shown)).id}`;
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

  const changed = ChangedSchema.parse(JSON.parse(counted));

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

// a remove of an imp that the failed create never recorded finds nothing,
// which leaves nothing behind
async function removeLeftovers(deps: TouchedPagesDeps): Promise<void> {
  const removedCopy = await deps.runInContainer(['rm', '-f', BASE_COPY]);
  const removedImp = await deps.runImpz(['rm', NAME]);

  if (removedCopy.exitCode !== 0) {
    deps.onStderr(`measure-touched-pages: could not remove ${BASE_COPY}: ${removedCopy.stderr}`);
  }

  if (removedImp.exitCode !== 0 && !/\bNOT_FOUND:/u.test(removedImp.stderr)) {
    deps.onStderr(`measure-touched-pages: could not remove ${NAME}: ${removedImp.stderr}`);
  }
}
