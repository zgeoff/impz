import type { Scope } from '@impz/api';
import type { MCPAuth } from '@zgeoff/mcp-auth';
import * as z from 'zod';
import type { ImpLimits } from '../../identity/oauth/imp-limits-schema';

const TokenResponseSchema = z.object({ access_token: z.string() });

// The client_credentials grant of a service client, through the token route.
export async function readServiceToken(
  auth: MCPAuth<Scope, ImpLimits>,
  name: string,
  secret: string,
): Promise<{
  readonly status: number;
  readonly error: string | null;
  readonly accessToken: string | null;
}> {
  const response = await auth.routes.token(
    new Request(`${auth.issuer}${auth.paths.machine.token}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${btoa(`service:${name}:${secret}`)}`,
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', resource: auth.resource }),
    }),
    { socketAddress: null, connectingIP: null, userAgent: null },
  );

  const json: unknown = await response.json();

  if (response.status !== 200) {
    const failure = z.object({ error: z.string() }).parse(json);

    return { status: response.status, error: failure.error, accessToken: null };
  }

  return {
    status: response.status,
    error: null,
    accessToken: TokenResponseSchema.parse(json).access_token,
  };
}
