import type { Endpoints } from '@wringer/core';
import { createRunClient } from './create-run-client.ts';

export async function sleepImp(
  endpoints: Endpoints,
  name: string,
): Promise<{ readonly name: string; readonly state: string }> {
  const client = await createRunClient(endpoints);
  const imp = await client.imps.sleep({ name });

  return { name: imp.name, state: imp.state };
}
