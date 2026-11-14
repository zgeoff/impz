import { readFile } from 'node:fs/promises';
import { createImpClient } from '@impz/client';
import type { ImpClient } from '@impz/client';
import type { Endpoints } from '@wringer/core';
import { parseRunEndpoints } from './run-endpoints.ts';

// A client of the run's impd with the token the app saved, the way an operator's script reaches it.
export async function createRunClient(endpoints: Endpoints): Promise<ImpClient> {
  const run = parseRunEndpoints(endpoints);

  const token = await readFile(run.tokenFile, 'utf8');

  return createImpClient({ url: run.web, token: token.trim() });
}
