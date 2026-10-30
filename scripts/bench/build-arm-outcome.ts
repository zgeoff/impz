import { BenchReportSchema } from '@impz/cli/bench-report-schema';
import { parseJSONOrNull } from '../lib/parse-json-or-null.ts';
import type { ArmReport } from './format-bench-compare';
import type { ArmRun } from './run-bench-arm';

export interface ArmRunName {
  readonly arm: string;
  readonly run: string;
}

export interface ArmOutcome {
  // a report is saved even when it does not parse, so its text stays to read
  readonly saved: string | null;
  readonly report: ArmReport | null;
  readonly isFailed: boolean;
  readonly notes: readonly string[];
}

export function buildArmOutcome(name: Readonly<ArmRunName>, ran: Readonly<ArmRun>): ArmOutcome {
  const isUnreadable =
    ran.json !== null && !BenchReportSchema.safeParse(parseJSONOrNull(ran.json)).success;

  const isMissing = ran.json === null;
  const isFailed = !ran.isPassed || isUnreadable || isMissing;

  const notes = [
    isMissing ? `bench arms: ${name.run} printed no report` : null,
    isUnreadable ? `bench arms: ${name.run} printed a report that does not parse` : null,
    isFailed ? `bench arms: ${name.run} failed; its impd log is in ${name.run}.impd.log` : null,
  ].filter((note) => note !== null);

  return {
    saved: ran.json,
    report: isMissing || isUnreadable ? null : { arm: name.arm, json: ran.json },
    isFailed,
    notes,
  };
}
