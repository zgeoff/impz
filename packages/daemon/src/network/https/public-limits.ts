import { createCountedLimit } from '../../platform/process/counted-limit';

// The limits count by imp, not by client: behind Docker's userland proxy every
// client can share one source address, so a limit by address would lock
// everyone out at once.

const MAX_OPEN = 64;
const WAKE_BUCKET = { size: 10, refillMs: 6000 };
const FAILURE_BUCKET = { size: 20, refillMs: 3000 };

export interface PublicLimits {
  readonly tryOpen: (impId: string) => (() => void) | null;

  readonly tryWake: (impId: string) => boolean;

  readonly tryFail: (impId: string) => boolean;

  readonly readRetryS: (kind: 'wake' | 'failure') => number;
}

interface Bucket {
  tokens: number;
  at: number;
}

export function createPublicLimits(now: () => number = Date.now): PublicLimits {
  const open = createCountedLimit(MAX_OPEN);
  const tryWake = createBuckets(WAKE_BUCKET, now);
  const tryFail = createBuckets(FAILURE_BUCKET, now);

  return {
    tryOpen: open.tryClaim,
    tryWake,
    tryFail,
    readRetryS: (kind) =>
      Math.ceil((kind === 'wake' ? WAKE_BUCKET : FAILURE_BUCKET).refillMs / 1000),
  };
}

// keys must be few, such as public imps or known clients: the map keeps a
// bucket for every key it has seen
export function createBuckets(
  spec: Readonly<{ size: number; refillMs: number }>,
  now: () => number,
): (key: string) => boolean {
  const buckets = new Map<string, Bucket>();

  return (key) => {
    const at = now();
    const bucket = buckets.get(key) ?? { tokens: spec.size, at };
    const refilled = Math.min(spec.size, bucket.tokens + (at - bucket.at) / spec.refillMs);
    const isTaken = refilled >= 1;

    buckets.set(key, { tokens: isTaken ? refilled - 1 : refilled, at });

    return isTaken;
  };
}
