import type { Scope } from '@impz/api';
import { getErrorMessage } from '@impz/shared';
import type { Access, MCPAuth, Requester } from '@zgeoff/mcp-auth';
import { createMCPHTTPApp } from '@zgeoff/mcp-auth/elysia';
import { Elysia, NotFound } from 'elysia';
import type { ImpdMcpAuth } from '../../identity/oauth/create-impd-mcp-auth';
import type { ImpLimits } from '../../identity/oauth/imp-limits-schema';
import { recordSecurityEvent } from '../../identity/oauth/record-security-event';
import type { Caller } from '../../platform/principal/caller';
import { getImpdLogger } from '../../platform/process/get-impd-logger';

// The public route serves nothing of impd's own, so no path lies beside the OAuth server.
const NO_OWN_PATHS = '/.impd-none';

interface PublicAppDeps {
  readonly auth: MCPAuth<Scope, ImpLimits>;

  // the Host header the front sends, which names the public origin
  readonly host: string;
  readonly readCaller: ImpdMcpAuth['readCaller'];
  readonly readRequester: (request: Request) => Requester;
  readonly respond: (request: Request, caller: Readonly<Caller>) => Promise<Response>;
}

export function createPublicApp(deps: PublicAppDeps) {
  const challenge = `Bearer error="invalid_token", resource_metadata="${deps.auth.issuer}${deps.auth.paths.machine.mcpResourceMetadata}"`;

  const respondToMcp = async (
    request: Request,
    access: Access<Scope, ImpLimits>,
  ): Promise<Response> => {
    const caller = await deps.readCaller(access);

    // The grant or its approving token went between the check and this read.
    if (caller === null) {
      return new Response(null, { status: 401, headers: { 'www-authenticate': challenge } });
    }

    return deps.respond(request, caller);
  };

  return new Elysia({ strictPath: true })
    .onError((context) => {
      if (context.error instanceof NotFound) {
        return new Response('not found', { status: 404 });
      }

      getImpdLogger('public').warning('public mcp: {error}', {
        error: getErrorMessage(context.error),
      });

      return new Response('internal error', { status: 500 });
    })
    .use(
      createMCPHTTPApp({
        auth: deps.auth,
        hosts: new Set([deps.host]),
        origins: new Set([deps.auth.issuer]),
        readRequester: deps.readRequester,
        security: { record: recordSecurityEvent },
        mcp: { fetch: respondToMcp },
        besidePrefix: NO_OWN_PATHS,
      }),
    );
}
