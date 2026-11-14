import type { Endpoints } from '@wringer/core';
import { createRunClient } from './create-run-client.ts';

export async function listImps(
  endpoints: Endpoints,
): Promise<{ readonly imps: readonly { readonly name: string; readonly state: string }[] }> {
  const client = await createRunClient(endpoints);
  const imps = await client.imps.list();

  return { imps: imps.map((imp) => ({ name: imp.name, state: imp.state })) };
}
