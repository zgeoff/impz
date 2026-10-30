// A mincore(2) diff writes each 2 MiB page a woken guest holds, read or
// written; this sets that beside the 4 KiB pages whose bytes changed, which a
// dirty-page diff would write. docs/runbooks/development.md#the-bench-job runs it.
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ImpSchema, SystemInfoSchema } from '@impz/api';
import { parseHugetlbMib } from '@impz/e2e-harness/huge-page-host';
import { $ } from 'bun';
import * as z from 'zod';
import { buildDevLayout } from '../lib/build-dev-layout.ts';
import { writeStderr } from '../lib/write-stderr.ts';

const IMPZ = resolve(import.meta.dir, '..', 'impz');

const LAYOUT = buildDevLayout({
  env: process.env,
  root: resolve(import.meta.dir, '..', '..'),
  cwd: process.cwd(),
});

const NAME = 'touched-pages';
const BASE_COPY = '/var/lib/imp/touched-pages-base';
const READY_TIMEOUT_MS = 300_000;
const ChangedSchema = z.object({ changedMib: z.number(), changedHugeMib: z.number() });
const ImpIDSchema = ImpSchema.pick({ id: true });
const InfoSchema = SystemInfoSchema.pick({ defaults: true });

async function main(): Promise<void> {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      memory: { type: 'string', default: '1g' },
      'write-mib': { type: 'string', default: '128' },
    },
  });

  const memory = parsed.values.memory;
  const writeMib = Number(parsed.values['write-mib']);

  await waitUntil('impd never added its default image', probeDefaultImage);

  await $`${IMPZ} ${['new', NAME, '--memory', memory]}`.quiet();

  try {
    await waitUntil(`${NAME} never ran a command`, probeExec);

    const shown: unknown = await $`${IMPZ} ${['info', NAME, '--json']}`.json();

    const directory = `/var/lib/imp/imps/${ImpIDSchema.parse(shown).id}`;
    const memFile = `${directory}/snapshot/mem`;

    // a cold boot sleeps as a diff over an empty file
    await runInImp(`dd if=/dev/urandom of=/dev/shm/written bs=1M count=${String(writeMib)}`);

    const coldTouchedMib = await readHugetlbMib(directory);

    await $`${IMPZ} ${['sleep', NAME]}`.quiet();

    const coldFileMib = await readAllocatedMib(memFile);

    // every page the woken guest reads back faults in from the handler, so the
    // diff takes it though no byte of it changed
    await $`${IMPZ} ${['wake', NAME]}`.quiet();

    await runInImp('sha256sum /dev/shm/written && sleep 5');

    const wokenTouchedMib = await readHugetlbMib(directory);
    const handlerPid = await readContainer(['cat', `${directory}/run/uffd.pid`]);

    await readContainer(['cp', '--sparse=always', `/proc/${handlerPid}/fd/3`, BASE_COPY]);

    await $`${IMPZ} ${['sleep', NAME]}`.quiet();

    const wokenFileMib = await readAllocatedMib(memFile);

    const counted = await readContainer([
      'bun',
      '/src/scripts/bench/count-changed-pages.ts',
      BASE_COPY,
      memFile,
    ]);

    const changed = ChangedSchema.parse(JSON.parse(counted));

    const measured = {
      memory,
      writeMib,
      coldSleep: { touchedMib: coldTouchedMib, memFileMib: coldFileMib },
      wokenSleep: {
        touchedMib: wokenTouchedMib,
        changedMib: changed.changedMib,
        changedHugeMib: changed.changedHugeMib,
        memFileMib: wokenFileMib,
      },
    };

    console.log(JSON.stringify(measured, null, 2));
  } finally {
    const removedCopy =
      await $`${LAYOUT.containerCLI} ${['exec', LAYOUT.name, 'rm', '-f', BASE_COPY]}`
        .quiet()
        .nothrow();

    const removedImp = await $`${IMPZ} ${['rm', NAME]}`.quiet().nothrow();

    for (const [what, removal] of [
      [BASE_COPY, removedCopy],
      [NAME, removedImp],
    ] as const) {
      if (removal.exitCode !== 0) {
        writeStderr(
          `measure-touched-pages: could not remove ${what}: ${removal.stderr.toString()}`,
        );
      }
    }
  }
}

async function probeDefaultImage(): Promise<boolean> {
  const shown = await $`${IMPZ} ${['info', '--json']}`.quiet().nothrow();

  if (shown.exitCode !== 0) {
    return false;
  }

  const info = InfoSchema.safeParse(shown.json());

  return info.success && (info.data.defaults?.image ?? null) !== null;
}

async function probeExec(): Promise<boolean> {
  const ran = await $`${IMPZ} ${['exec', NAME, '--', 'true']}`.quiet().nothrow();

  return ran.exitCode === 0;
}

async function waitUntil(failure: string, isDone: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;

  while (!(await isDone())) {
    if (Date.now() >= deadline) {
      throw new Error(`measure-touched-pages: ${failure}`);
    }

    await Bun.sleep(1000);
  }
}

async function runInImp(script: string): Promise<void> {
  await $`${IMPZ} ${['exec', NAME, '--', 'sh', '-c', script]}`.quiet();
}

async function readContainer(argv: readonly string[]): Promise<string> {
  const text = await $`${LAYOUT.containerCLI} ${['exec', LAYOUT.name, ...argv]}`.text();

  return text.trim();
}

async function readHugetlbMib(directory: string): Promise<number> {
  const pid = await readContainer(['cat', `${directory}/run/pid`]);
  const status = await readContainer(['cat', `/proc/${pid}/status`]);

  return parseHugetlbMib(status);
}

async function readAllocatedMib(path: string): Promise<number> {
  const blocks = await readContainer(['stat', '-c', '%b', path]);

  return Math.round((Number(blocks) * 512) / 1_048_576);
}

await main();
