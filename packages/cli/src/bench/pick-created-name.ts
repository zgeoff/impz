import { ORPCError } from '@impz/client';

interface FailedCreate {
  readonly error: unknown;

  // whether a lookup after the failed create found an imp under the name
  readonly isNameHeld: boolean;
}

// impd sets no field at create that a run could read back to know its own
// imp, so only a create call that returned the imp proves the run made it; a
// lost answer, even with the name taken since, may hide another run's CONFLICT
export function pickCreatedName(attempt: Readonly<FailedCreate>): 'leftover' | 'none' {
  if (attempt.error instanceof ORPCError && attempt.error.code === 'CONFLICT') {
    return 'none';
  }

  return attempt.isNameHeld ? 'leftover' : 'none';
}
