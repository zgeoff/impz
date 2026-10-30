import { join } from 'node:path';
import { BenchReportSchema } from '@impz/cli/bench-report-schema';
import { parseJSONOrNull } from '../lib/parse-json-or-null.ts';
import { formatBenchCompare } from './format-bench-compare';
import type { ArmReport } from './format-bench-compare';
import type { BenchArmsArgs } from './parse-bench-arms-args';
import type { ArmPlan, ArmRun } from './run-bench-arm';

export interface BenchComparisonDeps {
  readonly runArm: (plan: Readonly<Omit<ArmPlan, 'impz' | 'env' | 'cwd'>>) => Promise<ArmRun>;
  readonly makeDirectory: (path: string) => void;
  readonly writeReport: (path: string, json: string) => void;
  readonly appendSummary: ((text: string) => void) | null;
  readonly print: (text: string) => void;
  readonly printError: (text: string) => void;
}

// Each round runs every arm once, in order, so a long run's drift falls on
// each arm alike. A bench over its --limit-p50-ms, or with no sample, prints
// its report and still fails, so the comparison fails with it.
export async function runBenchComparison(
  deps: BenchComparisonDeps,
  args: Readonly<BenchArmsArgs>,
): Promise<number> {
  deps.makeDirectory(args.out);

  const reports: ArmReport[] = [];
  const missing: string[] = [];
  const failed: string[] = [];

  for (let round = 1; round <= args.rounds; round += 1) {
    for (const arm of args.arms) {
      const run = `${arm.name}-${String(round)}`;

      deps.printError(`bench arms: round ${String(round)}, ${arm.name}`);

      // an arm that stops leaves the rest of the rounds to run, and still fails
      // the comparison
      const ran = await deps
        .runArm({ arm, commands: args, logPath: join(args.out, `${run}.impd.log`) })
        .catch((error: unknown): ArmRun => {
          const reason = error instanceof Error ? error.message : String(error);

          deps.printError(`bench arms: ${run} stopped: ${reason}`);

          return { json: null, isPassed: false };
        });

      let isUnreadable = false;

      if (ran.json === null) {
        missing.push(run);
      } else {
        deps.writeReport(join(args.out, `${run}.json`), ran.json);

        isUnreadable = !BenchReportSchema.safeParse(parseJSONOrNull(ran.json)).success;

        if (isUnreadable) {
          deps.printError(`bench arms: ${run} printed a report that does not parse`);
          missing.push(run);
        } else {
          reports.push({ arm: arm.name, json: ran.json });
        }
      }

      if (!ran.isPassed || isUnreadable) {
        failed.push(run);
        deps.printError(`bench arms: ${run} failed; its impd log is in ${run}.impd.log`);
      }
    }
  }

  const table = formatBenchCompare(reports);

  deps.print(table);
  deps.appendSummary?.(`${table}\n`);

  if (missing.length > 0) {
    deps.printError(`bench arms: no report from ${missing.join(', ')}`);
  }

  if (failed.length > 0) {
    deps.printError(`bench arms: ${failed.join(', ')} failed`);

    return 1;
  }

  return 0;
}
