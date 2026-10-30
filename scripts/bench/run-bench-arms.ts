// Each round runs every arm once, in order, so a long run's drift falls on
// each arm alike; docs/runbooks/development.md#the-bench-job runs it.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { $ } from 'bun';
import { formatBenchCompare } from './format-bench-compare';
import type { ArmReport } from './format-bench-compare';
import { parseBenchArmsArgs } from './parse-bench-arms-args';
import { runBenchArm } from './run-bench-arm';
import type { BenchArmDeps } from './run-bench-arm';

const IMPZ = resolve(import.meta.dir, '..', 'impz');
const CONTAINER = process.env['IMP_DEV_NAME'] ?? 'imp-dev';

const ARM_DEPS: BenchArmDeps = {
  runDev: (script, command, env) => $`${script} ${[command]}`.env(env).text(),
  runImpz: async (args, env) => {
    const shown = await $`${IMPZ} ${args}`.env(env).quiet().nothrow();

    return {
      exitCode: shown.exitCode,
      stdout: shown.stdout.toString(),
      stderr: shown.stderr.toString(),
    };
  },
  readImpdLogs: async () => {
    const logs = await $`docker logs ${CONTAINER}`.quiet().nothrow();

    return Buffer.concat([logs.stdout, logs.stderr]);
  },
  wait: (durationMs) => Bun.sleep(durationMs),
  onStderr: (text) => {
    process.stderr.write(text);
  },
};

async function main(): Promise<void> {
  const args = parseBenchArmsArgs(process.argv.slice(2));

  if (typeof args === 'string') {
    console.error(args);
    process.exit(2);
  }

  mkdirSync(args.out, { recursive: true });

  const reports: ArmReport[] = [];
  const missing: string[] = [];
  const failed: string[] = [];

  for (let round = 1; round <= args.rounds; round += 1) {
    for (const arm of args.arms) {
      const run = `${arm.name}-${String(round)}`;

      console.error(`bench arms: round ${String(round)}, ${arm.name}`);

      const ran = await runBenchArm(ARM_DEPS, {
        arm,
        commands: args,
        logPath: join(args.out, `${run}.impd.log`),
      });

      if (ran.json === null) {
        missing.push(run);
      } else {
        writeFileSync(join(args.out, `${run}.json`), ran.json);

        reports.push({ arm: arm.name, json: ran.json });
      }

      if (!ran.isPassed) {
        failed.push(run);
        console.error(`bench arms: ${run} failed; its impd log is in ${run}.impd.log`);
      }
    }
  }

  const table = formatBenchCompare(reports);

  console.log(table);

  const summary = process.env['GITHUB_STEP_SUMMARY'];

  if (summary !== undefined) {
    appendFileSync(summary, `${table}\n`);
  }

  if (missing.length > 0) {
    console.error(`bench arms: no report from ${missing.join(', ')}`);
  }

  // a bench over its --limit-p50-ms, or with no sample, prints its report
  // and still fails, so the comparison fails with it
  if (failed.length > 0) {
    console.error(`bench arms: ${failed.join(', ')} failed`);
    process.exit(1);
  }
}

await main();
