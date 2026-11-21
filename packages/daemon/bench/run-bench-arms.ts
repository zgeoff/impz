// docs/runbooks/development.md#the-bench-job runs this comparison.
import { appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runCommand } from '@impz/e2e-harness/instance';
import { withDevLock } from '@impz/scripts/lib/with-dev-lock';
import { writeStderr } from '@impz/scripts/lib/write-stderr';
import { writeStdoutLine } from '@impz/scripts/lib/write-stdout-line';
import { writeText } from '@impz/scripts/lib/write-text';
import { systemClock } from '@zgeoff/std';
import { parseBenchArmsArgs } from '../src/test-utils/bench/parse-bench-arms-args';
import { runBenchArm } from '../src/test-utils/bench/run-bench-arm';
import type { BenchArmDeps } from '../src/test-utils/bench/run-bench-arm';
import { runBenchComparison } from '../src/test-utils/bench/run-bench-comparison';

const IMPZ = resolve(import.meta.dir, '..', '..', '..', 'scripts', 'impz');

const ARM_DEPS: BenchArmDeps = {
  withDevLock: (name, run) => withDevLock(tmpdir(), name, run),
  runCommand: (argv, env) => runCommand(argv, { env }),
  writeLog: writeText,
  now: systemClock.now,
  sleep: systemClock.sleep,
  onStderr: writeStderr,
};

const args = parseBenchArmsArgs(process.argv.slice(2));

if (typeof args === 'string') {
  writeStderr(`${args}\n`);

  process.exit(2);
}

const summary = process.env['GITHUB_STEP_SUMMARY'];

const code = await runBenchComparison(
  {
    runArm: (plan) =>
      runBenchArm(ARM_DEPS, { ...plan, impz: IMPZ, env: process.env, cwd: process.cwd() }),
    makeDirectory: (path) => {
      mkdirSync(path, { recursive: true });
    },
    writeReport: writeText,
    appendSummary:
      summary === undefined
        ? null
        : (text) => {
            appendFileSync(summary, text);
          },
    print: writeStdoutLine,
    printError: (text) => {
      writeStderr(`${text}\n`);
    },
  },
  args,
);

process.exit(code);
