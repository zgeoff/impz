import { SERVICE_CLIENT_IMPS, SERVICE_CLIENT_NAME, SERVICE_CLIENT_SCOPES } from './constants.ts';

interface ServiceFiles {
  readonly tokens: unknown;
  readonly clients: unknown;
}

// The service-token file and the service-clients file that let the run's service client sign in
// to the public MCP route at `resource`, as docs/guides/mcp.md#service-clients gives their shape.
export function buildServiceFiles(resource: string, digest: string): ServiceFiles {
  return {
    tokens: {
      resource,
      clients: {
        [SERVICE_CLIENT_NAME]: { scopes: SERVICE_CLIENT_SCOPES, secretDigests: [digest] },
      },
    },
    clients: { clients: { [SERVICE_CLIENT_NAME]: { imps: SERVICE_CLIENT_IMPS } } },
  };
}
