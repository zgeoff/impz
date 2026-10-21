import { createImpClient } from '@impz/client';
import type { ExecSocket } from '@impz/client';
import { createHttpTransport, createPatternGuard } from '@impz/mcp';
import type { HttpTransport } from '@impz/mcp';
import packageJson from '../../../package.json' with { type: 'json' };
import { isSameOrigin } from '../../identity/auth/authenticate';
import type { Caller } from '../../identity/auth/caller';

const IN_PROCESS_URL = 'http://impd.internal';

export interface McpEndpointDeps {
  readonly findCaller: (request: Request) => Promise<Caller | null>;
  readonly handleRpc: (request: Request, caller: Readonly<Caller>) => Promise<Response>;
  readonly connectExec: (url: string) => ExecSocket;
  readonly readEnds: (caller: Readonly<Caller>) => AbortSignal | null;
  readonly isCrossOrigin?: (request: Request) => boolean;
  readonly challenge?: string;
}

export function createMcpEndpoint(deps: Readonly<McpEndpointDeps>): HttpTransport {
  return createHttpTransport({
    version: packageJson.version,
    isCrossOrigin: deps.isCrossOrigin ?? isCrossOrigin,
    ...(deps.challenge !== undefined && { challenge: deps.challenge }),
    authenticate: async (request) => {
      const caller = await deps.findCaller(request);

      if (caller === null) {
        return null;
      }

      const sendClientRequest = (rpc: Request) => deps.handleRpc(rpc, caller);

      const client = createImpClient({
        url: IN_PROCESS_URL,
        fetch: sendClientRequest,
        connect: deps.connectExec,
      });

      return {
        key: `${caller.kind}:${caller.grantId ?? caller.tokenId ?? caller.name}`,
        scope: caller.scope,
        client,
        guard: createPatternGuard(caller.imps),
        ends: deps.readEnds(caller),
      };
    },
  });
}

// A browser names the page a request comes from in Sec-Fetch-Site or Origin.
// A client that is no browser sends neither, so the token alone counts.
function isCrossOrigin(request: Request): boolean {
  const fromBrowser = request.headers.has('sec-fetch-site') || request.headers.has('origin');

  return fromBrowser && !isSameOrigin(request);
}
