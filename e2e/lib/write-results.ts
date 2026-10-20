import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as z from 'zod';

// one suite's run, as the summary and results.json report it
export interface Section {
  readonly index: number;
  readonly name: string;
  readonly verdict: 'PASS' | 'FAIL';
  readonly durationMs: number;
}

export interface ResultsOptions {
  readonly resultsFile: string;

  // the file suites append metrics to; a run that wrote none has no file
  readonly metricsFile: string;
  readonly ramBudgetMib: number;
  readonly idleTimeoutS: number;
  readonly now: () => Date;
}

// one line of the metrics file a suite appends to: {"<key>": <value>}
const MetricSchema = z.record(z.string(), z.unknown());

// Writes results.json: the run's settings, a `section<n>` entry per suite
// with its verdict and duration, and every metric the suites appended.
export function writeResults(
  sections: readonly Section[],
  options: Readonly<ResultsOptions>,
): void {
  const metrics = existsSync(options.metricsFile)
    ? readFileSync(options.metricsFile, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => MetricSchema.parse(JSON.parse(line)))
    : [];

  const results: Record<string, unknown> = {
    runAt: options.now().toISOString(),
    ramBudgetMib: options.ramBudgetMib,
    idleTimeoutS: options.idleTimeoutS,
  };

  for (const section of sections) {
    results[`section${String(section.index)}`] = {
      name: section.name,
      verdict: section.verdict,
      durationMs: section.durationMs,
    };
  }

  Object.assign(results, ...metrics);

  writeFileSync(options.resultsFile, `${JSON.stringify(results, null, 2)}\n`);
}
