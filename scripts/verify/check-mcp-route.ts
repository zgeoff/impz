import { WringerError } from '@wringer/core';
import type { Endpoints } from '@wringer/core';
import * as z from 'zod';
import { pickMCPRouteProblem } from './pick-mcp-route-problem.ts';

// The doctor's `mcp-route` check: impd's public MCP route at the target's `mcp` origin answers, and
// its authorization server offers the grant a service client signs in with. It reads only.
export async function checkMCPRoute(
  endpoints: Endpoints,
  signal: AbortSignal,
): Promise<{ url: string }> {
  const origin = z.url().parse(endpoints['mcp']);

  const url = new URL('/mcp', origin);

  const hint = `Check that impd at ${origin} serves its public MCP route with both service-client files, then run \`bun verify doctor\` again.`;

  const answers = await readRouteAnswers(url, origin, signal).catch((error: unknown) => {
    throw new WringerError('check-failed', {
      message: `the public MCP route at ${url.href} does not answer: ${String(error)}`,
      hint,
    });
  });

  const problem = pickMCPRouteProblem(answers);

  if (problem !== null) {
    throw new WringerError('check-failed', { message: problem, hint });
  }

  return { url: url.href };
}

const serverMetadataSchema = z.object({ grant_types_supported: z.array(z.string()).default([]) });

async function readRouteAnswers(url: URL, origin: string, signal: AbortSignal) {
  const route = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    signal,
  });

  await route.body?.cancel();

  const server = await fetch(new URL('/.well-known/oauth-authorization-server', origin), {
    signal,
  });

  const body: unknown = await server.json();

  const metadata = serverMetadataSchema.parse(body);

  return {
    status: route.status,
    challenge: route.headers.get('www-authenticate') ?? '',
    grants: metadata.grant_types_supported,
  };
}
