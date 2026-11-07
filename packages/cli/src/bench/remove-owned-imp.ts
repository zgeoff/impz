import { ORPCError, isDefinedError, safe } from '@impz/client';
import type { ImpClient } from '../config/create-imp-client';

export interface Removal {
  readonly name: string;

  // replaced: another imp now holds the name, and the bench leaves it alone
  readonly outcome: 'removed' | 'replaced' | 'failed';
  readonly error: unknown;
}

// The destroy names the id the run's create returned, so impd refuses it once
// another imp holds the name, even one made there after a destroy whose answer
// was lost.
export async function removeOwnedImp(
  client: ImpClient,
  name: string,
  id: string,
): Promise<Removal> {
  const [error] = await safe(client.imps.destroy({ name, id }));

  if (error === null) {
    return { name, outcome: 'removed', error: null };
  }

  if (isDefinedError(error) && error.code === 'CONFLICT' && error.data.reason === 'id_changed') {
    return { name, outcome: 'replaced', error: null };
  }

  const isGone = error instanceof ORPCError && error.code === 'NOT_FOUND';

  return { name, outcome: isGone ? 'removed' : 'failed', error };
}
