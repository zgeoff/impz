import { createCountedLimit } from '../../platform/process/counted-limit';
import { createTokenBuckets } from '../../platform/process/token-buckets';

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

export function createPublicLimits(now: () => number = Date.now): PublicLimits {
  const open = createCountedLimit(MAX_OPEN);
  const tryWake = createTokenBuckets(() => WAKE_BUCKET, now);
  const tryFail = createTokenBuckets(() => FAILURE_BUCKET, now);

  return {
    tryOpen: open.tryClaim,
    tryWake,
    tryFail,
    readRetryS: (kind) =>
      Math.ceil((kind === 'wake' ? WAKE_BUCKET : FAILURE_BUCKET).refillMs / 1000),
  };
}
