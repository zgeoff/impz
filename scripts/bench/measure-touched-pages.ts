// A mincore(2) diff writes each 2 MiB page a woken guest holds, read or
// written; this sets that beside the 4 KiB pages whose bytes changed, which a
// dirty-page diff would write. docs/runbooks/development.md#the-bench-job runs it.
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { $ } from 'bun';
import { buildDevLayout } from '../lib/build-dev-layout.ts';
import { createDevLock } from '../lib/create-dev-lock.ts';
import { REPO_ROOT } from '../lib/repo-root.ts';
import { writeStderr } from '../lib/write-stderr.ts';
import { writeStdoutLine } from '../lib/write-stdout-line.ts';
import { runTouchedPages } from './run-touched-pages';

const IMPZ = resolve(import.meta.dir, '..', 'impz');

const parsed = parseArgs({
  args: process.argv.slice(2),
  options: {
    memory: { type: 'string', default: '1g' },
    'write-mib': { type: 'string', default: '128' },
  },
});

const writeMib = Number(parsed.values['write-mib']);

if (!Number.isInteger(writeMib) || writeMib < 1) {
  writeStderr(
    'usage: bun scripts/bench/measure-touched-pages.ts [--memory <size>] [--write-mib <n>]\n',
  );

  process.exit(2);
}

const layout = buildDevLayout({ env: process.env, root: REPO_ROOT, cwd: process.cwd() });

async function runCommand(argv: readonly string[]) {
  const ran = await $`${argv}`.quiet().nothrow();

  return { exitCode: ran.exitCode, stdout: ran.stdout.toString(), stderr: ran.stderr.toString() };
}

const measured = await runTouchedPages(
  {
    lockDev: () => createDevLock(tmpdir(), layout.name),
    runImpz: (args) => runCommand([IMPZ, ...args]),
    runInContainer: (argv) => runCommand([layout.containerCLI, 'exec', layout.name, ...argv]),
    now: () => Date.now(),
    wait: (durationMs) => Bun.sleep(durationMs),
    onStderr: (text) => {
      writeStderr(`${text}\n`);
    },
  },
  { memory: parsed.values.memory, writeMib },
);

writeStdoutLine(JSON.stringify(measured, null, 2));
