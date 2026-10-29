// A mincore(2) diff writes each 2 MiB page a woken guest holds, read or
// written; this sets that beside the 4 KiB pages whose bytes changed, which a
// dirty-page diff would write. docs/runbooks/development.md#the-bench-job runs it.
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parseHugetlbMib } from '@impz/e2e-harness/huge-page-host';
import { $ } from 'bun';
import * as z from 'zod';

const IMPZ = resolve(import.meta.dir, '..', 'impz');
const CONTAINER = process.env['IMP_DEV_NAME'] ?? 'imp-dev';
const NAME = 'touched-pages';
const BASE_COPY = '/var/lib/imp/touched-pages-base';
const READY_TIMEOUT_MS = 300_000;
const ChangedSchema = z.object({ changedMib: z.number(), changedHugeMib: z.number() });
const ImpSchema = z.looseObject({ id: z.string() });
const InfoSchema = z.looseObject({ defaults: z.looseObject({ image: z.string().nullable() }) });

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

  await $`${IMPZ} new ${NAME} --memory ${memory}`.quiet();

  try {
    await waitUntil(`${NAME} never ran a command`, probeExec);

    const shown = await $`${IMPZ} info ${NAME} --json`.json();

    const directory = `/var/lib/imp/imps/${ImpSchema.parse(shown).id}`;
    const memFile = `${directory}/snapshot/mem`;

    // a cold boot sleeps as a diff over an empty file
    await runInImp(`dd if=/dev/urandom of=/dev/shm/written bs=1M count=${String(writeMib)}`);

    const coldTouchedMib = await readHugetlbMib(directory);

    await $`${IMPZ} sleep ${NAME}`.quiet();

    const coldFileMib = await readAllocatedMib(memFile);

    // every page the woken guest reads back faults in from the handler, so the
    // diff takes it though no byte of it changed
    await $`${IMPZ} wake ${NAME}`.quiet();

    await runInImp('sha256sum /dev/shm/written && sleep 5');

    const wokenTouchedMib = await readHugetlbMib(directory);
    const handlerPid = await readContainer(['cat', `${directory}/run/uffd.pid`]);

    await readContainer(['cp', '--sparse=always', `/proc/${handlerPid}/fd/3`, BASE_COPY]);

    await $`${IMPZ} sleep ${NAME}`.quiet();

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
    await $`docker exec ${CONTAINER} rm -f ${BASE_COPY}`.quiet().nothrow();
    await $`${IMPZ} rm ${NAME}`.quiet().nothrow();
  }
}

async function probeDefaultImage(): Promise<boolean> {
  const shown = await $`${IMPZ} info --json`.quiet().nothrow();

  if (shown.exitCode !== 0) {
    return false;
  }

  const info = InfoSchema.safeParse(shown.json());

  return info.success && info.data.defaults.image !== null;
}

async function probeExec(): Promise<boolean> {
  const ran = await $`${IMPZ} exec ${NAME} -- true`.quiet().nothrow();

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
  await $`${IMPZ} exec ${NAME} -- sh -c ${script}`.quiet();
}

async function readContainer(argv: readonly string[]): Promise<string> {
  const text = await $`docker exec ${CONTAINER} ${argv}`.text();

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
