import { isUnauthorized } from '../../lib/build-query-client';

export type FailureOutcome =
  | { readonly kind: 'ignore' }
  | { readonly kind: 'login' }
  | { readonly kind: 'show'; readonly message: string };

export function pickFailureOutcome(error: unknown, aborted: boolean): FailureOutcome {
  if (aborted) {
    return { kind: 'ignore' };
  }

  if (isUnauthorized(error)) {
    return { kind: 'login' };
  }

  return { kind: 'show', message: error instanceof Error ? error.message : String(error) };
}
