// docs/runbooks/development.md#the-bench-job runs this comparison.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { $ } from 'bun';
import { createDevLock } from '../lib/create-dev-lock.ts';
import { writeStderr } from '../lib/write-stderr.ts';
import { writeStdoutLine } from '../lib/write-stdout-line.ts';
import { writeText } from '../lib/write-text.ts';
import { parseBenchArmsArgs } from './parse-bench-arms-args';
import { runBenchArm } from './run-bench-arm';
import type { BenchArmDeps } from './run-bench-arm';
import { runBenchComparison } from './run-bench-comparison';

const IMPZ = resolve(import.meta.dir, '..', 'impz');

const ARM_DEPS: BenchArmDeps = {
  lockDev: (name) => createDevLock(tmpdir(), name),
  inspectDev: async (cli, name) => {
    const inspect = await $`${cli} ${['inspect', '-f', '{{.State.Running}}', name]}`
      .quiet()
      .nothrow();

    return {
      exitCode: inspect.exitCode,
      stdout: inspect.stdout.toString(),
      stderr: inspect.stderr.toString(),
    };
  },
  runDev: (script, command, env) => $`${script} ${[command]}`.env(env).text(),
  runImpz: async (args, env) => {
    const shown = await $`${IMPZ} ${args}`.env(env).quiet().nothrow();

    return {
      exitCode: shown.exitCode,
      stdout: shown.stdout.toString(),
      stderr: shown.stderr.toString(),
    };
  },
  readImpdLogs: async (cli, name) => {
    const logs = await $`${cli} ${['logs', name]}`.quiet().nothrow();

    return { exitCode: logs.exitCode, output: Buffer.concat([logs.stdout, logs.stderr]) };
  },
  writeLog: (path, output) => {
    writeFileSync(path, output);
  },
  now: () => Date.now(),
  wait: (durationMs) => Bun.sleep(durationMs),
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
    runArm: (plan) => runBenchArm(ARM_DEPS, { ...plan, env: process.env, cwd: process.cwd() }),
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
