// docs/runbooks/development.md#the-bench-job runs this comparison.
import { appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { REAL_CLOCK } from '@impz/daemon/real-clock';
import { runCommand } from '@impz/e2e-harness/instance';
import { createDevLock } from '../lib/create-dev-lock.ts';
import { wireDevLockIO } from '../lib/wire-dev-lock-io.ts';
import { writeStderr } from '../lib/write-stderr.ts';
import { writeStdoutLine } from '../lib/write-stdout-line.ts';
import { writeText } from '../lib/write-text.ts';
import { parseBenchArmsArgs } from './parse-bench-arms-args';
import { runBenchArm } from './run-bench-arm';
import type { BenchArmDeps } from './run-bench-arm';
import { runBenchComparison } from './run-bench-comparison';

const IMPZ = resolve(import.meta.dir, '..', 'impz');

const ARM_DEPS: BenchArmDeps = {
  lockDev: (name) => createDevLock(wireDevLockIO(), tmpdir(), name),
  runCommand: (argv, env) => runCommand(argv, { env }),
  writeLog: writeText,
  now: REAL_CLOCK.now,
  sleep: REAL_CLOCK.sleep,
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
