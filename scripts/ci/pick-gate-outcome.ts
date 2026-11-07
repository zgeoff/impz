import * as z from 'zod';

const OutputsSchema = z.record(z.string(), z.string());
const NeedSchema = z.looseObject({ result: z.string(), outputs: OutputsSchema.optional() });

export const GateNeedsSchema = z.record(z.string(), NeedSchema);

export type GateNeeds = z.infer<typeof GateNeedsSchema>;

// 'replaced' passes only when a newer run of the workflow on the branch will report the gate.
export type GateOutcome = 'pass' | 'fail' | 'replaced';

// A newer run's concurrency cancels an older run's jobs, and so do a timeout and a cancel by hand,
// so a cancelled job leaves the answer to whether a newer run exists.
export function pickGateOutcome(needs: Readonly<GateNeeds>): GateOutcome {
  const { changes, ...jobs } = needs;
  const results = Object.values(jobs).map((job) => job.result);

  if (changes?.outputs?.['changed'] === 'false') {
    return results.every((result) => result === 'skipped') ? 'pass' : 'fail';
  }

  if (results.every((result) => result === 'success')) {
    return 'pass';
  }

  const every = new Set([changes?.result, ...results]);

  return every.has('cancelled') && !every.has('failure') ? 'replaced' : 'fail';
}

export function isRunReplaced(runIds: readonly number[], runId: number): boolean {
  return runIds.some((id) => id > runId);
}
