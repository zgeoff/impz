export const EVENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const EVENT_MAX_ROWS = 100_000;

interface PruneFacts {
  readonly now: number;
  readonly oldestKeptSeq: number | null;
  readonly lastAgedSeq: number | null;
  readonly lastCountedSeq: number | null;
}

export type PrunePlan =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'prune';
      readonly beforeAt: number;
      readonly belowSeq: number;
      readonly prunedThrough: number;
    };

export function pickPrunePlan(facts: PruneFacts): PrunePlan {
  if (facts.lastAgedSeq === null && facts.lastCountedSeq === null) {
    return { kind: 'none' };
  }

  return {
    kind: 'prune',
    beforeAt: facts.now - EVENT_MAX_AGE_MS,
    belowSeq: facts.oldestKeptSeq ?? 0,
    prunedThrough: Math.max(facts.lastAgedSeq ?? 0, facts.lastCountedSeq ?? 0),
  };
}
