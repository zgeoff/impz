import { READ_TOOLS } from './constants.ts';

interface ServiceClient {
  readonly name: string;
  readonly secretEnv: string;
  readonly scope: string;
}

// The mcp driver's one server, `impz`: the public MCP route at `origin`, signed in through the
// client_credentials grant as `client`. The credentials go only to the authorization server at
// `origin`, which is the route's own issuer.
export function buildMCPConfig(origin: string, client: ServiceClient) {
  return {
    servers: {
      impz: {
        transport: 'http' as const,
        url: `${origin}/mcp`,
        auth: {
          clientCredentials: {
            clientID: `service:${client.name}`,
            secretEnv: client.secretEnv,
            scope: client.scope,
            issuer: origin,
          },
        },
        readTools: [...READ_TOOLS],
      },
    },
  };
}
