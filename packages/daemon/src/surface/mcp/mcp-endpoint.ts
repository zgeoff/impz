import { createImpClient } from '@impz/client';
import type { ExecSocket } from '@impz/client';
import { createHttpTransport, createPatternGuard } from '@impz/mcp';
import type { HttpTransport } from '@impz/mcp';
import packageJson from '../../../package.json' with { type: 'json' };
import type { Caller } from '../../identity/auth/caller';
import { isAllowedOrigin } from '../../platform/http/is-allowed-origin';

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
    isCrossOrigin:
      deps.isCrossOrigin ??
      ((request) => !isAllowedOrigin(request, { kind: 'browser-same-origin' })),
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
