export const RETRY_KEY_KEEP_MS = 24 * 60 * 60 * 1000;

interface RetryHolder {
  readonly kind: string;
  readonly params: string;
  readonly endedAt: number | null;
}

interface RetryRequest {
  readonly kind: string;
  readonly params: string;
  readonly now: number;
}

export type RetryOutcome = 'expired' | 'existing' | 'conflict';

export function pickRetryOutcome(holder: RetryHolder, request: RetryRequest): RetryOutcome {
  if (holder.endedAt !== null && holder.endedAt <= request.now - RETRY_KEY_KEEP_MS) {
    return 'expired';
  }

  return holder.kind === request.kind && holder.params === request.params ? 'existing' : 'conflict';
}
