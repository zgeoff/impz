import type { Imp } from '@impz/api';
import { ORPCError } from '@impz/client';
import type { ImpClient } from '../config/create-imp-client';

export async function readImp(client: ImpClient, name: string): Promise<Imp | null> {
  try {
    return await client.imps.get({ name });
  } catch (error) {
    if (error instanceof ORPCError && error.code === 'NOT_FOUND') {
      return null;
    }

    throw error;
  }
}
