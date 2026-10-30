// A mincore(2) diff writes each 2 MiB page a woken guest holds, read or
// written; this sets that beside the 4 KiB pages whose bytes changed, which a
// dirty-page diff would write. docs/runbooks/development.md#the-bench-job runs it.
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { REAL_CLOCK } from '@impz/daemon/real-clock';
import { createInstanceClient, readImpEnv } from '@impz/e2e-harness/imp-cli';
import { instance, runCommand, runInContainer } from '@impz/e2e-harness/instance';
import { createDevLock } from '../lib/create-dev-lock.ts';
import { wireDevLockIO } from '../lib/wire-dev-lock-io.ts';
import { writeStderr } from '../lib/write-stderr.ts';
import { writeStdoutLine } from '../lib/write-stdout-line.ts';
import { parseTouchedPagesArgs } from './parse-touched-pages-args';
import { runTouchedPages } from './run-touched-pages';

const IMPZ = resolve(import.meta.dir, '..', 'impz');
const options = parseTouchedPagesArgs(process.argv.slice(2));

if (typeof options === 'string') {
  writeStderr(`${options}\n`);

  process.exit(2);
}

// IMP_HOST names a saved host and wins over IMP_URL, so an empty one keeps
// every command on the dev instance
const IMPZ_ENV = { IMP_HOST: '', ...(await readImpEnv(instance)) };

const measured = await runTouchedPages(
  {
    lockDev: () => createDevLock(wireDevLockIO(), tmpdir(), instance.container),
    client: await createInstanceClient(instance),
    runImpz: (args) => runCommand([IMPZ, ...args], { env: IMPZ_ENV }),
    runInContainer: (argv) => runInContainer(argv, instance),
    now: REAL_CLOCK.now,
    sleep: REAL_CLOCK.sleep,
    onStderr: (text) => {
      writeStderr(`${text}\n`);
    },
  },
  options,
);

writeStdoutLine(JSON.stringify(measured, null, 2));
