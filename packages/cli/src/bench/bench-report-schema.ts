import * as z from 'zod';

const LatencySummarySchema = z
  .object({ p50: z.number(), p95: z.number(), p99: z.number(), max: z.number() })
  .readonly();

export type LatencySummary = z.infer<typeof LatencySummarySchema>;

const BenchResultSchema = z
  .object({
    scenario: z.string(),
    concurrency: z.number(),
    samples: z.number(),
    failures: z.record(z.string(), z.number()).readonly(),
    latencyMs: LatencySummarySchema.nullable(),
    impdMs: LatencySummarySchema.nullable(),
    memFileMib: LatencySummarySchema.nullable(),
  })
  .readonly();

export type BenchResult = z.infer<typeof BenchResultSchema>;

// the part of `impz bench --json` that programs which compare runs read
export const BenchReportSchema = z.looseObject({ results: z.array(BenchResultSchema).readonly() });
