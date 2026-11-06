export const RETRY_KEY_KEEP_MS = 24 * 60 * 60 * 1000;

interface RetryRequest {
  readonly kind: string;
  readonly params: string;
  readonly targetId: string | null;
  readonly principal: string;
}

interface RetryHolder extends RetryRequest {
  readonly endedAt: number | null;
}

export type RetryOutcome = 'expired' | 'existing' | 'conflict';

export function pickRetryOutcome(
  holder: RetryHolder,
  request: RetryRequest & { readonly now: number },
): RetryOutcome {
  if (holder.endedAt !== null && holder.endedAt <= request.now - RETRY_KEY_KEEP_MS) {
    return 'expired';
  }

  return isSameRequest(holder, request) ? 'existing' : 'conflict';
}

function isSameRequest(holder: RetryRequest, request: RetryRequest): boolean {
  return (
    holder.kind === request.kind &&
    holder.params === request.params &&
    holder.targetId === request.targetId &&
    holder.principal === request.principal
  );
}
