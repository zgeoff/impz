import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as z from 'zod';

export interface Section {
  readonly index: number;
  readonly name: string;
  readonly verdict: 'PASS' | 'FAIL';
  readonly durationMs: number;
}

export interface ResultsOptions {
  readonly resultsFile: string;

  readonly metricsFile: string;
  readonly ramBudgetMib: number;
  readonly idleTimeoutS: number;
  readonly now: () => Date;
}

const MetricSchema = z.record(z.string(), z.unknown());

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
