import { ORPCError } from '@impz/client';
import type { Endpoints } from '@wringer/core';
import { createRunClient } from './create-run-client.ts';

// Destroys the imp. An imp that is already gone counts as removed, so a journey that stopped
// halfway can run its last step again.
export async function removeImp(
  endpoints: Endpoints,
  name: string,
): Promise<{ readonly removed: string; readonly existed: boolean }> {
  const client = await createRunClient(endpoints);

  try {
    await client.imps.destroy({ name });
  } catch (error) {
    if (error instanceof ORPCError && error.code === 'NOT_FOUND') {
      return { removed: name, existed: false };
    }

    throw error;
  }

  return { removed: name, existed: true };
}
