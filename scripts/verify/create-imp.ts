import type { Endpoints } from '@wringer/core';
import { IMAGE_NAME } from './constants.ts';
import { createRunClient } from './create-run-client.ts';

// Creates the imp from the run's `tiny` image, as an operator with the root token.
export async function createImp(
  endpoints: Endpoints,
  name: string,
): Promise<{ readonly name: string; readonly state: string }> {
  const client = await createRunClient(endpoints);
  const imp = await client.imps.create({ name, image: IMAGE_NAME });

  return { name: imp.name, state: imp.state };
}
